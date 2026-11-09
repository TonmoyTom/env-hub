'use strict';

// Looks up images and tags on Docker Hub. Only the public, free API is used, with no login.
// Anonymous requests are rate limited, which is fine for a person typing in a form.
const HUB = 'https://hub.docker.com/v2';
const TIMEOUT_MS = 8000;
const REPO_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/;

async function getJson(url, fetchFn) {
  let res;
  try {
    res = await fetchFn(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error('Could not reach Docker Hub. Check your internet connection.');
  }
  if (res.status === 429) {
    throw new Error('Docker Hub is busy right now. Wait a moment and try again.');
  }
  if (!res.ok) {
    throw new Error(`Docker Hub answered with an error (${res.status})`);
  }
  return res.json();
}

// Images that match the text, official ones first. Returns [{ name, description, stars, official }].
async function searchImages(query, fetchFn = fetch) {
  const text = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (text.length < 2 || text.length > 100) {
    return [];
  }

  const url = `${HUB}/search/repositories/?query=${encodeURIComponent(text)}&page_size=10`;
  const data = await getJson(url, fetchFn);
  const results = Array.isArray(data && data.results) ? data.results : [];

  return results
    .filter((r) => r && typeof r.repo_name === 'string' && REPO_RE.test(r.repo_name))
    .map((r) => ({
      name: r.repo_name,
      description: typeof r.short_description === 'string' ? r.short_description.slice(0, 160) : '',
      stars: Number.isInteger(r.star_count) ? r.star_count : 0,
      official: r.is_official === true,
    }))
    .sort((a, b) => Number(b.official) - Number(a.official) || b.stars - a.stars);
}

// Recent tags of one image, newest first. Returns an array of tag names.
async function listTags(image, fetchFn = fetch) {
  const repo = typeof image === 'string' ? image.trim().toLowerCase() : '';
  if (!REPO_RE.test(repo)) {
    throw new Error('Invalid image name');
  }

  const path = repo.includes('/') ? repo : `library/${repo}`;
  const url = `${HUB}/repositories/${path}/tags?page_size=30&ordering=last_updated`;
  const data = await getJson(url, fetchFn);
  const results = Array.isArray(data && data.results) ? data.results : [];

  return results
    .map((t) => t && t.name)
    .filter((name) => typeof name === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(name));
}

// Does this image (and tag) exist on Docker Hub? Returns true or false, or null when it cannot be told:
// the image is on another registry (ghcr.io/...), or Docker Hub could not be reached.
async function imageExists(image, fetchFn = fetch) {
  const text = typeof image === 'string' ? image.trim() : '';
  const first = text.split('/')[0];
  if (text.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    return null;
  }

  const colon = text.lastIndexOf(':');
  const hasTag = colon > text.lastIndexOf('/');
  const repo = (hasTag ? text.slice(0, colon) : text).toLowerCase();
  const tag = hasTag ? text.slice(colon + 1) : 'latest';
  if (!REPO_RE.test(repo) || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
    return false;
  }

  const path = repo.includes('/') ? repo : `library/${repo}`;
  try {
    const res = await fetchFn(`${HUB}/repositories/${path}/tags/${encodeURIComponent(tag)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return false;
    return res.ok ? true : null;
  } catch (err) {
    return null;
  }
}

// Where each version list comes from. The tag shapes are the ones envhub builds images from:
// php:<v>-fpm, node:<v>-alpine, mysql:<v>, postgres:<v>, mongo:<v>, redis:<v>.
// Node: only even majors (the LTS lines), the odd ones are short lived.
// MySQL: the 8.0 and 8.4 lines, and 9.7 or newer (9.7 is an LTS line, 26.7 / 26.10 ... are the calendar versioned
// Innovation releases). The old Innovation tags (8.1 to 8.3, 9.0 to 9.6) are out of support and stay hidden.
function acceptMysql(version) {
  const [major, minor] = version.split('.').map(Number);
  return version === '8.0' || version === '8.4' || major > 9 || (major === 9 && minor >= 7);
}

const VERSION_SOURCES = {
  php: { image: 'php', filter: '-fpm', tag: /^(\d{1,2}\.\d{1,2})-fpm$/ },
  node: { image: 'node', filter: '-alpine', tag: /^(\d{1,3})-alpine$/, accept: (v) => Number(v) % 2 === 0 },
  mysql: { image: 'mysql', filter: '', tag: /^(\d{1,2}\.\d{1,2})$/, accept: acceptMysql },
  postgres: { image: 'postgres', filter: '', tag: /^(\d{1,3})$/ },
  mongodb: { image: 'mongo', filter: '', tag: /^(\d{1,2})$/ },
  redis: { image: 'redis', filter: '', tag: /^(\d{1,2})$/ },
};
const VERSION_PAGES = 3;

// The versions Docker Hub has for one list (php, node, mysql, postgres, mongodb, redis), as strings like '8.4' or '22'.
// Looks at the most recently updated tags (3 pages of 100), which is where the maintained versions are.
async function listVersionTags(key, fetchFn = fetch) {
  const source = VERSION_SOURCES[key];
  if (!source) {
    throw new Error('Unknown version list');
  }

  const found = new Set();
  const filter = source.filter ? `&name=${encodeURIComponent(source.filter)}` : '';
  let url = `${HUB}/repositories/library/${source.image}/tags?page_size=100&ordering=last_updated${filter}`;

  for (let page = 0; page < VERSION_PAGES && url; page += 1) {
    const data = await getJson(url, fetchFn);
    const results = Array.isArray(data && data.results) ? data.results : [];
    for (const item of results) {
      const match = item && typeof item.name === 'string' ? source.tag.exec(item.name) : null;
      if (match && (!source.accept || source.accept(match[1]))) found.add(match[1]);
    }
    // Only follow a next link that stays on Docker Hub.
    url = data && typeof data.next === 'string' && data.next.startsWith(`${HUB}/`) ? data.next : null;
  }
  return [...found];
}

// All six lists at once. A list that fails or comes back empty is left out and reported, it never throws.
// Returns { lists: { php: ['8.4', ...], ... }, errors: ['php: ...'] }.
async function fetchVersionLists(fetchFn = fetch) {
  const keys = Object.keys(VERSION_SOURCES);
  const settled = await Promise.allSettled(keys.map((key) => listVersionTags(key, fetchFn)));
  const lists = {};
  const errors = [];
  settled.forEach((result, i) => {
    if (result.status === 'rejected') errors.push(`${keys[i]}: ${result.reason && result.reason.message}`);
    else if (result.value.length === 0) errors.push(`${keys[i]}: no versions found`);
    else lists[keys[i]] = result.value;
  });
  return { lists, errors };
}

module.exports = { searchImages, listTags, imageExists, listVersionTags, fetchVersionLists };
