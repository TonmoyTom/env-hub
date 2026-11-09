'use strict';

const fs = require('fs');
const path = require('path');
const { NAME_RE } = require('../compose/generate');
const registry = require('../registry/versions');
const { NODE_STACKS, NODE_STACK_DEFS } = require('../stacks/node');
const { portableFiles } = require('./portable-compose');
const { languageOf } = require('../stacks/languages');
const { mergeEnv } = require('./installer');
const { frameworkFiles } = require('../stacks/python-frameworks');

const GITIGNORE = '.env\nvendor/\nnode_modules/\n';

// Writes Dockerfile (when the stack builds one), docker-compose.yml, .env and .gitignore.
// Existing files are never overwritten by a later step, because each project folder is new.
// After "Install a fresh app" the folder already holds the app's own .env and .gitignore:
// the .env lines are merged into it, and the .gitignore is kept.
function writePortableFiles(folder, spec, { installed = false, extraEnv = '' } = {}) {
  const files = portableFiles(spec);
  if (files.dockerfile) fs.writeFileSync(path.join(folder, 'Dockerfile'), files.dockerfile);
  fs.writeFileSync(path.join(folder, 'docker-compose.yml'), files.compose);

  const envFile = path.join(folder, '.env');
  const ours = files.env + extraEnv;
  const text = installed && fs.existsSync(envFile) ? mergeEnv(fs.readFileSync(envFile, 'utf8'), ours) : ours;
  fs.writeFileSync(envFile, text, { mode: 0o600 });

  const ignoreFile = path.join(folder, '.gitignore');
  if (!(installed && fs.existsSync(ignoreFile))) fs.writeFileSync(ignoreFile, GITIGNORE);
}

// Called after the generator has filled the folder.
function finishInstall(folder, spec) {
  // Laravel's default session table does not exist when MySQL is chosen, so use files until the user migrates.
  const dbTicked = spec.options && (spec.options.mysql || spec.options.postgres);
  const extraEnv = spec.stack === 'laravel' && dbTicked ? 'SESSION_DRIVER=file\nCACHE_STORE=file\nQUEUE_CONNECTION=sync\n' : '';
  writePortableFiles(folder, spec, { installed: true, extraEnv });
}

function phpDockerfile(version) {
  return `FROM php:${version}-fpm

RUN apt-get update \\
 && apt-get install -y --no-install-recommends \\
      git unzip libzip-dev libonig-dev libicu-dev \\
 && docker-php-ext-install pdo_mysql mbstring zip bcmath intl \\
 && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html
`;
}

const NGINX_CONF = `server {
    listen 80;
    server_name _;
    root /var/www/html/public;
    index index.php index.html;
    client_max_body_size 64M;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        fastcgi_pass php:9000;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
    }
}
`;

// Placeholder page. Replace the whole folder with your Laravel app when ready.
function placeholderIndex(name) {
  return `<?php
// Placeholder created by envhub for the project "${name}".
// Replace this folder with your Laravel app. Keep public/ as the web root.
?>
<!doctype html>
<html>
<head><meta charset="utf-8"><title>${name}</title></head>
<body>
  <h1>envhub is running: ${name}</h1>
  <p>PHP <?php echo PHP_VERSION; ?></p>
</body>
</html>
`;
}

// The PHP Dockerfile and nginx file of a Laravel project that was not created by envhub.
function writeLaravelSupport(dir, phpVersion) {
  if (!registry.has('php', phpVersion)) throw new Error('Unsupported PHP version');
  fs.mkdirSync(path.join(dir, 'php'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'nginx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'php', 'Dockerfile'), phpDockerfile(phpVersion));
  fs.writeFileSync(path.join(dir, 'nginx', 'default.conf'), NGINX_CONF);
}

// Creates a new project folder with starter files. Refuses to touch an existing folder.
// Also writes docker-compose.yml (relative paths) and .env, so the folder works on another server.
// Returns the absolute folder path.
function scaffoldLaravel({ baseDir, name, phpVersion, options, versions, dbPassword, extraServices, install }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('Invalid project name');
  }
  if (!registry.has('php', phpVersion)) {
    throw new Error('Unsupported PHP version');
  }

  const folder = path.join(baseDir, name);
  if (fs.existsSync(folder)) {
    throw new Error(`Folder already exists: ${folder}`);
  }

  fs.mkdirSync(path.join(folder, 'docker', 'php'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'docker', 'nginx'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'docker', 'php', 'Dockerfile'), phpDockerfile(phpVersion));
  fs.writeFileSync(path.join(folder, 'docker', 'nginx', 'default.conf'), NGINX_CONF);

  // With "install", the generator needs an empty folder, so it runs first (see prepareInstall)
  // and the rest is written afterwards by finishInstall.
  if (install) return folder;

  fs.mkdirSync(path.join(folder, 'public'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'public', 'index.php'), placeholderIndex(name));
  writePortableFiles(folder, { stack: 'laravel', name, phpVersion, options, versions, dbPassword, extraServices });

  return folder;
}

// Placeholder server so a new Node project starts and shows a page.
// Replace the files in the folder with a real NestJS or Next.js app.
function nodeServer(name, label, port) {
  return `'use strict';

// Placeholder created by envhub for the project "${name}".
// Replace the files in this folder with your ${label} app.
const http = require('http');

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>envhub is running: ${name}</h1><p>${label} placeholder on Node ' + process.version + '</p>');
  })
  .listen(${port}, '0.0.0.0');
`;
}

// Creates a new Node project folder. Refuses to touch an existing folder.
// Returns the absolute folder path.
function scaffoldNode({ baseDir, name, stack, nodeVersion, options, versions, dbPassword, extraServices, install }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('Invalid project name');
  }
  if (!NODE_STACKS.includes(stack)) {
    throw new Error('Unsupported stack');
  }
  if (!registry.has('node', nodeVersion)) {
    throw new Error('Unsupported Node version');
  }

  const folder = path.join(baseDir, name);
  if (fs.existsSync(folder)) {
    throw new Error(`Folder already exists: ${folder}`);
  }

  fs.mkdirSync(folder, { recursive: true });

  // "Install a fresh app": no server.js. The generator fills the empty folder, then finishInstall runs.
  if (install) return folder;

  const pkg = {
    name,
    private: true,
    scripts: { dev: 'node server.js', 'start:dev': 'node server.js' },
  };
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(folder, 'server.js'), nodeServer(name, NODE_STACK_DEFS[stack].label, NODE_STACK_DEFS[stack].port));
  writePortableFiles(folder, { stack, name, nodeVersion, options, versions, dbPassword, extraServices });

  return folder;
}

// Creates an empty project folder for a Docker image stack. Refuses to touch an existing folder.
function scaffoldDocker({ baseDir, name, image, containerPort, command, options, versions, dbPassword, extraServices, install, framework }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('Invalid project name');
  }

  const folder = path.join(baseDir, name);
  if (fs.existsSync(folder)) {
    throw new Error(`Folder already exists: ${folder}`);
  }

  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'README.md'),
    `# ${name}\n\nThis folder is mounted at /app inside the \`${image}\` container.\nPut your code here.\n`,
  );
  // Starter files for known languages, so the project shows a page as soon as it starts.
  const lang = languageOf(image);
  if (framework) {
    // Python framework starter (Flask, Django, FastAPI): its files replace the plain starter.
    for (const [rel, content] of Object.entries(frameworkFiles(framework, options))) {
      const file = path.join(folder, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  } else if (lang) {
    // "install" = clean project: only the dependency file the Dockerfile needs, no placeholder code.
    for (const [rel, content] of Object.entries(lang.files)) {
      if (install && !(lang.keep || []).includes(rel)) continue;
      const file = path.join(folder, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
  writePortableFiles(folder, { stack: 'docker', name, image, containerPort, command, options, versions, dbPassword, extraServices });
  return folder;
}

module.exports = { scaffoldLaravel, scaffoldNode, scaffoldDocker, finishInstall, writeLaravelSupport };
