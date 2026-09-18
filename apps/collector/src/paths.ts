/**
 * Path translation between host and container.
 *
 * The agents run on the HOST; the collector runs in a container and reaches
 * their state through bind mounts. So two edges must translate, and getting
 * either wrong fails quietly:
 *
 *   inbound  — hook events arrive from the host carrying host paths, and must
 *              become container paths before we touch the filesystem.
 *              Getting this wrong: ENOENT, or worse, reading the wrong file.
 *
 *   outbound — everything written to projects.path, tool_calls.cwd and
 *              file_changes.path must be the HOST path the user recognises.
 *              Getting this wrong: a dashboard full of /host/code/... paths
 *              that open on no machine. The database rejects those with a
 *              CHECK constraint, so this is a loud failure by construction —
 *              but translating here is what keeps it from ever firing.
 */

export interface PathMapping {
  hostPrefix: string;
  containerPrefix: string;
}

export class PathMapError extends Error {}

/** Strip trailing slashes so '/a/b/' and '/a/b' behave identically. */
function normalizePrefix(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Prefix match on SEGMENT boundaries.
 *
 * A naive startsWith would make '/host/code/app' match the prefix
 * '/host/code/ap', producing a silently corrupt translation. Either the path
 * equals the prefix exactly, or the next character is a separator.
 */
function hasPrefix(path: string, prefix: string): boolean {
  if (prefix === '/') return path.startsWith('/');
  return path === prefix || path.startsWith(`${prefix}/`);
}

function replacePrefix(path: string, from: string, to: string): string {
  const rest = from === '/' ? path.slice(1) : path.slice(from.length);
  if (rest === '') return to;
  const base = to === '/' ? '' : to;
  return `${base}${rest.startsWith('/') ? '' : '/'}${rest}`;
}

export class PathMapper {
  private readonly mappings: readonly PathMapping[];

  constructor(mappings: PathMapping[]) {
    this.mappings = mappings.map((m) => ({
      hostPrefix: normalizePrefix(m.hostPrefix),
      containerPrefix: normalizePrefix(m.containerPrefix),
    }));
    this.assertNoShadowing();
  }

  /**
   * Parse `PATH_MAP` — comma-separated `host_prefix:container_prefix` pairs.
   *
   * Host paths on macOS routinely contain spaces ("/Volumes/Macintosh HD 1"),
   * and Windows paths contain a drive colon, so we split on the LAST colon in
   * each pair rather than the first, and never trim interior whitespace.
   */
  static parse(raw: string): PathMapper {
    const mappings: PathMapping[] = [];
    for (const entry of raw.split(',')) {
      const pair = entry.trim();
      if (pair === '') continue;
      const idx = pair.lastIndexOf(':');
      if (idx <= 0 || idx === pair.length - 1) {
        throw new PathMapError(
          `PATH_MAP entry "${pair}" is not host_prefix:container_prefix`,
        );
      }
      const hostPrefix = pair.slice(0, idx);
      const containerPrefix = pair.slice(idx + 1);
      if (!hostPrefix.startsWith('/') || !containerPrefix.startsWith('/')) {
        throw new PathMapError(
          `PATH_MAP entry "${pair}" must use absolute paths on both sides`,
        );
      }
      mappings.push({ hostPrefix, containerPrefix });
    }
    if (mappings.length === 0) {
      throw new PathMapError('PATH_MAP is empty — the collector cannot translate any path');
    }
    return new PathMapper(mappings);
  }

  /**
   * The spec calls PATH_MAP "ordered", so first match wins. That makes it
   * possible to write a config where an earlier, shorter prefix shadows a
   * later one and the later mapping is simply dead — a bug that shows up as
   * "some projects have wrong paths" weeks later. Refuse at startup instead.
   */
  private assertNoShadowing(): void {
    for (let i = 0; i < this.mappings.length; i++) {
      for (let j = i + 1; j < this.mappings.length; j++) {
        const earlier = this.mappings[i]!;
        const later = this.mappings[j]!;
        if (hasPrefix(later.hostPrefix, earlier.hostPrefix)) {
          throw new PathMapError(
            `PATH_MAP entry ${j + 1} ("${later.hostPrefix}") is shadowed by entry ${i + 1} ` +
              `("${earlier.hostPrefix}") and would never match. List the more specific prefix first.`,
          );
        }
        if (hasPrefix(later.containerPrefix, earlier.containerPrefix)) {
          throw new PathMapError(
            `PATH_MAP container prefix ${j + 1} ("${later.containerPrefix}") is shadowed by ` +
              `entry ${i + 1} ("${earlier.containerPrefix}"). List the more specific prefix first.`,
          );
        }
      }
    }
  }

  /** Inbound: a host path from a hook event → the container path to open. */
  toContainer(hostPath: string): string {
    for (const m of this.mappings) {
      if (hasPrefix(hostPath, m.hostPrefix)) {
        return replacePrefix(hostPath, m.hostPrefix, m.containerPrefix);
      }
    }
    throw new PathMapError(
      `No PATH_MAP entry covers host path "${hostPath}". Add a mapping and a matching ` +
        `read-only bind mount, or the collector cannot read this project.`,
    );
  }

  /** Outbound: a container path → the host path to store. */
  toHost(containerPath: string): string {
    for (const m of this.mappings) {
      if (hasPrefix(containerPath, m.containerPrefix)) {
        return replacePrefix(containerPath, m.containerPrefix, m.hostPrefix);
      }
    }
    throw new PathMapError(
      `No PATH_MAP entry covers container path "${containerPath}" — refusing to store it. ` +
        `A /host/... path in the database is never correct.`,
    );
  }

  /** Outbound, tolerant: paths outside every mapping pass through unchanged. */
  toHostIfMapped(path: string): string {
    for (const m of this.mappings) {
      if (hasPrefix(path, m.containerPrefix)) {
        return replacePrefix(path, m.containerPrefix, m.hostPrefix);
      }
    }
    return path;
  }

  /**
   * Last line of defence before an insert. The database enforces this too, but
   * failing here names the value and the caller instead of surfacing as a
   * constraint violation three frames away.
   */
  static assertHostPath(path: string, field: string): void {
    if (path.startsWith('/host/')) {
      throw new PathMapError(
        `Refusing to store container path "${path}" in ${field}. ` +
          `Translate with PathMapper.toHost() before insert.`,
      );
    }
  }

  get entries(): readonly PathMapping[] {
    return this.mappings;
  }
}
