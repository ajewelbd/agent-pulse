/**
 * File watching.
 *
 * Bind-mount inotify is unreliable on Docker Desktop (macOS/Windows) and fine
 * on native Linux. Rather than assume, `auto` probes: write to a scratch path
 * inside a mounted directory and see whether an event actually arrives. If it
 * does not within the timeout, fall back to polling.
 *
 * Whichever mode is chosen is logged at startup — a silent watcher that never
 * fires looks exactly like an adapter that finds nothing.
 */
import { watch, type FSWatcher } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WatchMode } from './config.js';

export type ResolvedWatchMode = 'inotify' | 'poll';

const PROBE_TIMEOUT_MS = 1500;

/**
 * Probe a directory for working inotify.
 *
 * Note the probe needs a WRITABLE directory. All /host mounts are read-only by
 * design, so callers pass a container-local scratch dir. That makes this a
 * test of the platform's inotify support rather than of a specific mount —
 * which is the right question: on Docker Desktop the whole virtiofs/gRPC-FUSE
 * layer is what drops events.
 */
export async function probeInotify(scratchDir: string): Promise<boolean> {
  const probeFile = join(scratchDir, `.agentpulse-watch-probe-${process.pid}`);
  let watcher: FSWatcher | undefined;
  try {
    await writeFile(probeFile, 'probe');
    const fired = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
      try {
        watcher = watch(scratchDir, () => {
          clearTimeout(timer);
          resolve(true);
        });
      } catch {
        clearTimeout(timer);
        resolve(false);
        return;
      }
      // Trigger after the watch is established.
      setTimeout(() => {
        writeFile(probeFile, `probe-${Date.now()}`).catch(() => {});
      }, 50);
    });
    return fired;
  } catch {
    return false;
  } finally {
    watcher?.close();
    await unlink(probeFile).catch(() => {});
  }
}

export async function resolveWatchMode(
  configured: WatchMode,
  scratchDir: string,
): Promise<ResolvedWatchMode> {
  if (configured === 'inotify') return 'inotify';
  if (configured === 'poll') return 'poll';
  const works = await probeInotify(scratchDir);
  return works ? 'inotify' : 'poll';
}

export interface WatcherOptions {
  mode: ResolvedWatchMode;
  pollIntervalMs: number;
  /** Directories to watch (container paths). */
  roots: string[];
  onChange: () => void;
}

/**
 * Coalescing watcher. Agents append to transcripts continuously, so raw events
 * would fire a scan per line; every trigger is debounced into one scan.
 */
export class Watcher {
  private readonly watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly options: WatcherOptions) {}

  start(): void {
    if (this.options.mode === 'inotify') {
      for (const root of this.options.roots) {
        try {
          // recursive is supported on macOS and (since Node 20) Linux; if it
          // throws we fall back to polling rather than watching nothing.
          const w = watch(root, { recursive: true }, () => this.schedule());
          this.watchers.push(w);
        } catch {
          process.stderr.write(
            `recursive watch failed for ${root}; falling back to polling for this root\n`,
          );
          this.startPolling();
          return;
        }
      }
      return;
    }
    this.startPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.schedule(), this.options.pollIntervalMs);
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.options.onChange(), 200);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const w of this.watchers) w.close();
  }
}
