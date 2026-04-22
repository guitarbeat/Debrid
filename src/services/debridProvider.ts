import type WebTorrent from 'webtorrent';
import type { Torrent, TorrentFile as WTFile } from 'webtorrent';
import { TorrentInfo, DebridProviderOptions, TorrentEngineStatus } from '../types';
import { config } from '../config';

type WebTorrentConstructor = new (options: {
  maxConns?: number;
  downloadLimit?: number;
  uploadLimit?: number;
}) => WebTorrent.Instance;

const importWebTorrentModule = new Function(
  'modulePath',
  'return import(modulePath);'
) as (modulePath: string) => Promise<unknown>;

let webTorrentConstructorPromise: Promise<WebTorrentConstructor> | null = null;

async function loadWebTorrentConstructor(): Promise<WebTorrentConstructor> {
  if (!webTorrentConstructorPromise) {
    webTorrentConstructorPromise = importWebTorrentModule('webtorrent')
      .then((moduleExports: unknown) => {
        const moduleWithDefault = moduleExports as { default?: unknown } | null;
        const constructorCandidate = moduleWithDefault?.default ?? moduleExports;
        if (typeof constructorCandidate !== 'function') {
          throw new Error('Failed to resolve WebTorrent constructor');
        }

        return constructorCandidate as WebTorrentConstructor;
      });
  }

  return webTorrentConstructorPromise;
}

/**
 * DebridProvider - Core torrent engine abstraction
 * Handles torrent downloading, streaming, and file management
 */
export class DebridProvider {
  private client: WebTorrent.Instance | null;
  private clientInitPromise: Promise<WebTorrent.Instance> | null;
  private activeTorrents: Map<string, Torrent>;
  private options: DebridProviderOptions;

  constructor(options: DebridProviderOptions = {}) {
    this.options = {
      timeout: options.timeout || config.torrentTimeout,
      maxConnections: options.maxConnections || 55,
      downloadPath: options.downloadPath || config.downloadPath,
    };

    this.client = null;
    this.clientInitPromise = null;
    this.activeTorrents = new Map();

    // Cleanup handler
    this.setupCleanup();
  }

  /**
   * Lazily initialize WebTorrent to avoid boot-time crashes from runtime module format mismatches.
   */
  private async getClient(): Promise<WebTorrent.Instance> {
    if (this.client) {
      return this.client;
    }

    if (!this.clientInitPromise) {
      this.clientInitPromise = loadWebTorrentConstructor().then((WebTorrentCtor) =>
        new WebTorrentCtor({
          maxConns: this.options.maxConnections,
          downloadLimit: -1,
          uploadLimit: -1,
        })
      );
    }

    this.client = await this.clientInitPromise;
    return this.client;
  }

  /**
   * Add a torrent by magnet URI, info hash, or torrent file URL
   */
  async addTorrent(magnetOrInfoHash: string): Promise<TorrentInfo> {
    const client = await this.getClient();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Torrent metadata timeout'));
      }, this.options.timeout);

      try {
        // Normalize input to magnet URI
        let magnetUri = magnetOrInfoHash;
        if (magnetOrInfoHash.length === 40 && !magnetOrInfoHash.includes(':')) {
          // It's an info hash
          magnetUri = `magnet:?xt=urn:btih:${magnetOrInfoHash}`;
        }

        const torrent = client.add(magnetUri, {
          path: this.options.downloadPath,
        });

        torrent.on('metadata', () => {
          clearTimeout(timeoutId);

          const torrentInfo: TorrentInfo = {
            infoHash: torrent.infoHash,
            name: torrent.name,
            magnetURI: torrent.magnetURI,
            length: torrent.length,
            files: torrent.files.map((file: WTFile) => ({
              name: file.name,
              path: file.path,
              length: file.length,
            })),
          };

          this.activeTorrents.set(torrent.infoHash, torrent);
          this.enforceMaxTorrents();

          resolve(torrentInfo);
        });

        torrent.once('error', (err: Error) => {
          clearTimeout(timeoutId);
          reject(err);
        });

      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Get torrent information by info hash
   */
  getTorrent(infoHash: string): Torrent | undefined {
    const activeTorrent = this.activeTorrents.get(infoHash);
    if (activeTorrent || !this.client) {
      return activeTorrent;
    }

    return this.client.torrents.find(t => t.infoHash === infoHash);
  }

  /**
   * Get torrent status
   */
  getTorrentStatus(infoHash: string): TorrentEngineStatus | null {
    const torrent = this.getTorrent(infoHash);
    if (!torrent) return null;

    return {
      infoHash: torrent.infoHash,
      progress: torrent.progress,
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      numPeers: torrent.numPeers,
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded,
      ready: torrent.ready,
    };
  }

  /**
   * Get the best video file from a torrent
   */
  getBestVideoFile(torrent: Torrent): WTFile | null {
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];

    const videoFiles = torrent.files.filter(file =>
      videoExtensions.some(ext => file.name.toLowerCase().endsWith(ext))
    );

    if (videoFiles.length === 0) return null;

    // Return the largest video file
    return videoFiles.reduce((largest, file) =>
      file.length > largest.length ? file : largest
    );
  }

  /**
   * Get file by index
   */
  getFileByIndex(torrent: Torrent, index: number): WTFile | null {
    return torrent.files[index] || null;
  }

  /**
   * Create a streaming URL for a file
   */
  async createStreamUrl(infoHash: string, fileIndex?: number): Promise<string> {
    const torrent = this.getTorrent(infoHash);
    if (!torrent) {
      throw new Error('Torrent not found');
    }

    // Wait for torrent to be ready
    if (!torrent.ready) {
      await this.waitForTorrentReady(torrent);
    }

    let file: WTFile | null;
    if (fileIndex !== undefined) {
      file = this.getFileByIndex(torrent, fileIndex);
    } else {
      file = this.getBestVideoFile(torrent);
    }

    if (!file) {
      throw new Error('No suitable video file found');
    }

    // Create streaming endpoint URL
    return `${config.baseUrl}/stream/${infoHash}/${torrent.files.indexOf(file)}`;
  }

  /**
   * Wait for torrent to be ready for streaming
   */
  private waitForTorrentReady(torrent: Torrent, timeout: number = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (torrent.ready) {
        resolve();
        return;
      }

      const timeoutId = setTimeout(() => {
        reject(new Error('Torrent ready timeout'));
      }, timeout);

      torrent.once('ready', () => {
        clearTimeout(timeoutId);
        resolve();
      });

      torrent.once('error', (err: Error) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  }

  /**
   * Stream file by creating a readable stream
   */
  createFileStream(infoHash: string, fileIndex: number, range?: { start: number; end: number }) {
    const torrent = this.getTorrent(infoHash);
    if (!torrent) {
      throw new Error('Torrent not found');
    }

    const file = this.getFileByIndex(torrent, fileIndex);
    if (!file) {
      throw new Error('File not found');
    }

    if (range) {
      return file.createReadStream({
        start: range.start,
        end: range.end,
      });
    }

    return file.createReadStream();
  }

  /**
   * Remove a torrent
   */
  removeTorrent(infoHash: string): void {
    const torrent = this.getTorrent(infoHash);
    if (torrent) {
      torrent.destroy();
      this.activeTorrents.delete(infoHash);
    }
  }

  /**
   * Enforce maximum number of active torrents
   */
  private enforceMaxTorrents(): void {
    if (this.activeTorrents.size > config.maxTorrents) {
      // Remove oldest torrent
      const oldestHash = Array.from(this.activeTorrents.keys())[0];
      this.removeTorrent(oldestHash);
    }
  }

  /**
   * Setup cleanup handlers
   */
  private setupCleanup(): void {
    // Cleanup inactive torrents periodically
    setInterval(() => {
      const now = Date.now();
      for (const [infoHash, torrent] of this.activeTorrents.entries()) {
        // Remove torrents with no activity for 10 minutes
        if (torrent.downloadSpeed === 0 && torrent.uploadSpeed === 0) {
          const lastActive = (torrent as any)._lastActive || 0;
          if (now - lastActive > 600000) {
            this.removeTorrent(infoHash);
          }
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Get all active torrents info
   */
  getActiveTorrents(): TorrentEngineStatus[] {
    return Array.from(this.activeTorrents.values()).map(torrent => ({
      infoHash: torrent.infoHash,
      progress: torrent.progress,
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      numPeers: torrent.numPeers,
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded,
      ready: torrent.ready,
    }));
  }

  /**
   * Destroy the client
   */
  async destroy(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.client) {
        resolve();
        return;
      }

      this.client.destroy((err) => {
        if (err) console.error('Error destroying torrent client:', err);
        this.client = null;
        this.clientInitPromise = null;
        resolve();
      });
    });
  }
}

// Singleton instance
let debridProviderInstance: DebridProvider | null = null;

export function getDebridProvider(): DebridProvider {
  if (!debridProviderInstance) {
    debridProviderInstance = new DebridProvider();
  }
  return debridProviderInstance;
}
