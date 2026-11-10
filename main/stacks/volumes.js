'use strict';

// What the "Volumes" tab shows: every Docker volume a project uses, and the folders of the computer that are
// shared into its containers. Pure: it takes the project config and what Docker reported, and returns plain data.

// The volume names that hold things that can be installed again (a cache), not your own data.
const CACHE_VOLUMES = new Set(['packages', 'node-modules', 'go', 'registry', 'target', 'm2', 'gems']);

// What a volume is for, in words for the user.
function purposeOf(volumeName) {
  if (volumeName === 'data') return { kind: 'data', label: 'Data', note: 'Your database or store data. It stays when the project is stopped or restarted.' };
  if (CACHE_VOLUMES.has(volumeName)) return { kind: 'cache', label: 'Installed packages', note: 'Packages and build files. They can be installed again, so losing them only costs time.' };
  return { kind: 'other', label: 'Other', note: '' };
}

// `existing` = names of the volumes Docker has for this project. `sizes` = [{ name, bytes }] from Docker.
// Volume names are the ones the compose file uses: envhub-<project>-<service>-<volume>.
function describeVolumes(config, projectName, existing = [], sizes = []) {
  const have = new Set(existing);
  const bytesOf = new Map(sizes.map((s) => [s.name, s.bytes]));
  const volumes = [];
  const folders = [];

  for (const svc of config.services || []) {
    for (const v of svc.dataVolumes || []) {
      const name = `envhub-${projectName}-${svc.name}-${v.name}`;
      const purpose = purposeOf(v.name);
      volumes.push({
        name,
        service: svc.name,
        volume: v.name,
        target: v.target,
        kind: purpose.kind,
        label: purpose.label,
        note: purpose.note,
        exists: have.has(name),
        bytes: bytesOf.has(name) ? bytesOf.get(name) : null,
      });
    }
    for (const mount of svc.volumes || []) {
      folders.push({ service: svc.name, source: mount.source, target: mount.target });
    }
  }

  const totalBytes = volumes.reduce((sum, v) => sum + (v.bytes || 0), 0);
  return { volumes, folders, totalBytes };
}

module.exports = { describeVolumes, purposeOf, CACHE_VOLUMES };
