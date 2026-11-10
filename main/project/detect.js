'use strict';

// Looks into an existing project folder (for example a git clone) and guesses the stack and version.
// Nothing is written. The user can still change every guess in the Setup step.

const fs = require('fs');
const path = require('path');
const registry = require('../registry/versions');
const { NAME_RE } = require('../compose/generate');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

// A folder name turned into a valid project name ("My Shop_2" -> "my-shop-2").
function suggestName(folder) {
  let name = path.basename(folder).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(name)) name = `app-${name}`.replace(/-+$/, '');
  name = name.slice(0, 40).replace(/-+$/, '');
  return NAME_RE.test(name) ? name : 'myapp';
}

// "^8.2", ">=8.1", "~8.3.0", "^8.2|^8.3" -> the lowest "8.2". Null when nothing is readable.
function lowestPhp(constraint) {
  const found = String(constraint || '').match(/(\d+)\.(\d+)/g);
  if (!found) return null;
  return found.sort((a, b) => {
    const [a1, a2] = a.split('.').map(Number);
    const [b1, b2] = b.split('.').map(Number);
    return a1 - b1 || a2 - b2;
  })[0];
}

// The offered PHP version that suits the project: its lowest allowed version, else the next one up.
function pickPhp(constraint) {
  const low = lowestPhp(constraint);
  const offered = registry.list('php').map(String);
  if (low && offered.includes(low)) return low;
  if (low) {
    const [m, n] = low.split('.').map(Number);
    const higher = offered.filter((v) => { const [a, b] = v.split('.').map(Number); return a > m || (a === m && b >= n); });
    if (higher.length) return higher.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  }
  return registry.defaultOf('php');
}

// ".nvmrc" or "engines.node" -> an offered Node major version, else the default.
function pickNode(folder, pkg) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(folder, '.nvmrc'), 'utf8');
  } catch (err) {
    text = pkg && pkg.engines && pkg.engines.node ? String(pkg.engines.node) : '';
  }
  const match = /(\d{2})/.exec(text);
  return match && registry.has('node', match[1]) ? match[1] : registry.defaultOf('node');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return '';
  }
}

function has(folder, ...names) {
  return names.some((n) => fs.existsSync(path.join(folder, n)));
}

// "3.11.4" or "python-3.11.4" or ">=3.10" -> "3.11", "3.10". Null when there is no number.
function majorMinor(text) {
  const m = /(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? `${m[1]}.${m[2]}` : null;
}

// Languages without their own ProjectDockHub stack run as a "Docker image" project: an image, a port and a
// start command that installs the packages first. Every part can be changed in the Setup step.
// Returns { image, port, command, label, note } or null.
function detectLanguage(folder, pkg) {
  const text = (name) => readText(path.join(folder, name));

  if (has(folder, 'go.mod')) {
    const v = /^go\s+(\d+\.\d+)/m.exec(text('go.mod'));
    return { label: 'Go', image: `golang:${v ? v[1] : '1.23'}`, port: 8080, command: 'go run .', note: 'Go: your app must listen on 0.0.0.0 and the port shown here.' };
  }

  if (has(folder, 'Cargo.toml')) {
    return { label: 'Rust', image: 'rust:1', port: 8080, command: 'cargo run', note: 'Rust: your app must listen on 0.0.0.0 and the port shown here.' };
  }

  if (has(folder, 'pom.xml', 'build.gradle', 'build.gradle.kts')) {
    const pom = text('pom.xml');
    const java = (/<java\.version>\s*(\d+)/.exec(pom) || /<maven\.compiler\.(?:release|source)>\s*(\d+)/.exec(pom) || [])[1];
    const jdk = ['8', '11', '17', '21', '25'].includes(java) ? java : '21';
    if (has(folder, 'pom.xml')) {
      const boot = /spring-boot/.test(pom);
      return { label: 'Java (Maven)', image: `maven:3-eclipse-temurin-${jdk}`, port: 8080, command: boot ? 'mvn -q spring-boot:run' : 'mvn -q package && java -jar target/*.jar', note: 'Maven: the first start downloads the packages, which takes a while.' };
    }
    return { label: 'Java (Gradle)', image: `gradle:jdk${jdk}`, port: 8080, command: 'gradle bootRun', note: 'Gradle: the first start downloads the packages, which takes a while.' };
  }

  if (has(folder, 'requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'manage.py', 'app.py', 'main.py')) {
    const required = /requires-python\s*=\s*"([^"]+)"/.exec(text('pyproject.toml'));
    const py = majorMinor(text('.python-version')) || majorMinor(text('runtime.txt')) || majorMinor(required && required[1]) || '3.12';
    const install = has(folder, 'requirements.txt') ? 'pip install --no-cache-dir -r requirements.txt && ' : has(folder, 'pyproject.toml') ? 'pip install --no-cache-dir . && ' : '';
    const main = has(folder, 'app.py') ? 'app' : has(folder, 'main.py') ? 'main' : null;
    const source = main ? text(`${main}.py`).toLowerCase() : '';
    let run = '';
    let port = 8000;
    let note = 'Python: check the start command, it is a guess.';
    if (has(folder, 'manage.py')) {
      run = 'python manage.py runserver 0.0.0.0:8000';
      note = 'Django: add your host to ALLOWED_HOSTS if the page shows a "DisallowedHost" error.';
    } else if (main && source.includes('fastapi')) {
      run = `uvicorn ${main}:app --host 0.0.0.0 --port 8000`;
      note = 'FastAPI: uvicorn must be in requirements.txt, and your app object must be called "app".';
    } else if (main) {
      run = `python ${main}.py`;
      if (source.includes('flask')) {
        port = 5000;
        note = 'Flask: use app.run(host="0.0.0.0") in your code, or the page will not open from your computer.';
      }
    }
    return { label: 'Python', image: `python:${py}`, port, command: run ? `${install}${run}` : '', note };
  }

  if (has(folder, 'Gemfile')) {
    const rb = majorMinor(text('.ruby-version')) || '3.3';
    const rails = has(folder, 'bin/rails');
    return {
      label: 'Ruby',
      image: `ruby:${rb}`,
      port: rails ? 3000 : 9292,
      command: rails ? 'bundle install && bundle exec rails server -b 0.0.0.0' : 'bundle install && bundle exec rackup -o 0.0.0.0',
      note: 'Ruby: the first start installs the gems, which takes a while.',
    };
  }

  if (pkg) {
    const scripts = pkg.scripts || {};
    const run = scripts.start ? 'npm start' : scripts.dev ? 'npm run dev' : '';
    return {
      label: 'Node.js',
      image: `node:${pickNode(folder, pkg)}-alpine`,
      port: 3000,
      command: run ? `npm install && ${run}` : '',
      note: 'Node: your app must listen on 0.0.0.0 and the port shown here.',
    };
  }

  return null;
}

function detectProject(folder) {
  const result = { stack: null, version: null, name: suggestName(folder), hasVendor: false, hasEnv: false };

  const composer = readJson(path.join(folder, 'composer.json'));
  if (composer && composer.require && composer.require['laravel/framework']) {
    result.stack = 'laravel';
    result.version = pickPhp(composer.require.php);
    result.hasVendor = fs.existsSync(path.join(folder, 'vendor', 'autoload.php'));
    result.hasEnv = fs.existsSync(path.join(folder, '.env'));
    return result;
  }

  const pkg = readJson(path.join(folder, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
    // Order matters: Nuxt and Next also depend on vue / react.
    const stack = deps.nuxt ? 'nuxt' : deps.next ? 'nextjs' : deps['@nestjs/core'] ? 'nestjs' : deps.vue ? 'vue' : null;
    if (stack) {
      result.stack = stack;
      result.version = pickNode(folder, pkg);
      return result;
    }
  }

  // No ProjectDockHub stack of its own: a language, run as a Docker image project.
  const lang = detectLanguage(folder, pkg);
  if (lang) {
    result.stack = 'docker';
    result.language = lang;
  }
  return result;
}

module.exports = { detectProject, detectLanguage, suggestName, pickPhp, lowestPhp };
