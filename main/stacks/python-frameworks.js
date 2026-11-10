'use strict';

// Starter projects for Python on the "Docker image" stack: Flask, Django, FastAPI.
// The user picks one in Setup. ProjectDockHub writes the starter files, the packages go into requirements.txt
// (pip install runs when the project starts), and the database that was ticked is wired in through
// environment variables (see `databaseEnv`) and a small db.py that shows if the connection works.

const FRAMEWORKS = {
  flask: { label: 'Flask', port: 5000, packages: ['flask'], run: 'python app.py' },
  fastapi: { label: 'FastAPI', port: 8000, packages: ['fastapi', 'uvicorn'], run: 'uvicorn main:app --host 0.0.0.0 --port $PORT --reload' },
  django: { label: 'Django', port: 8000, packages: ['django'], run: 'python manage.py runserver 0.0.0.0:$PORT' },
};
const FRAMEWORK_KEYS = Object.keys(FRAMEWORKS);

// Python driver for each database. cryptography is needed by pymysql for MySQL 8 logins.
const DB_PACKAGES = { mysql: ['pymysql', 'cryptography'], postgres: ['psycopg2-binary'], mongodb: ['pymongo'] };

// A framework only applies to a Python image. Returns the key, '' for plain Python, and throws on a wrong value.
function normalizeFramework(value, image) {
  if (value === undefined || value === null || value === '' || value === 'plain') return '';
  if (!FRAMEWORK_KEYS.includes(value)) throw new Error('Unsupported framework');
  if (!/^python(:|$)/.test(String(image || '').trim())) throw new Error('A framework needs a Python image');
  return value;
}

function packagesFor(framework, opts) {
  const list = [...FRAMEWORKS[framework].packages];
  for (const [key, pkgs] of Object.entries(DB_PACKAGES)) {
    if (opts && opts[key]) list.push(...pkgs);
  }
  return list;
}

// The start command: install the packages, then run.
function frameworkCommand(framework) {
  return `pip install --no-cache-dir -r requirements.txt && ${FRAMEWORKS[framework].run}`;
}

// db.py: tells which of the ticked databases the app can reach. Values come from environment variables.
function dbModule(opts) {
  const parts = ['import os', '', '', 'def status():', '    lines = []'];
  if (opts.mysql) {
    parts.push(
      '    try:',
      '        import pymysql',
      '        pymysql.connect(host=os.environ["MYSQL_HOST"], port=int(os.environ["MYSQL_PORT"]), user=os.environ["MYSQL_USER"],',
      '                        password=os.environ["MYSQL_PASSWORD"], database=os.environ["MYSQL_DATABASE"], connect_timeout=3).close()',
      '        lines.append("MySQL: connected")',
      '    except Exception as error:',
      '        lines.append("MySQL: not connected (" + str(error) + ")")',
    );
  }
  if (opts.postgres) {
    parts.push(
      '    try:',
      '        import psycopg2',
      '        psycopg2.connect(host=os.environ["POSTGRES_HOST"], port=os.environ["POSTGRES_PORT"], user=os.environ["POSTGRES_USER"],',
      '                         password=os.environ["POSTGRES_PASSWORD"], dbname=os.environ["POSTGRES_DB"], connect_timeout=3).close()',
      '        lines.append("PostgreSQL: connected")',
      '    except Exception as error:',
      '        lines.append("PostgreSQL: not connected (" + str(error) + ")")',
    );
  }
  if (opts.mongodb) {
    parts.push(
      '    try:',
      '        import pymongo',
      '        pymongo.MongoClient(os.environ["MONGODB_URL"], serverSelectionTimeoutMS=3000).admin.command("ping")',
      '        lines.append("MongoDB: connected")',
      '    except Exception as error:',
      '        lines.append("MongoDB: not connected (" + str(error) + ")")',
    );
  }
  parts.push('    return "\\n".join(lines) if lines else "No database selected"', '');
  return parts.join('\n');
}

const FLASK_APP = `import os

from flask import Flask

import db

app = Flask(__name__)


@app.route("/")
def home():
    return "<h1>Hello from Flask</h1><pre>" + db.status() + "</pre>"


if __name__ == "__main__":
    # 0.0.0.0 so the page opens from your computer, not only inside the container
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
`;

const FASTAPI_APP = `from fastapi import FastAPI
from fastapi.responses import HTMLResponse

import db

app = FastAPI()


@app.get("/", response_class=HTMLResponse)
def home():
    return "<h1>Hello from FastAPI</h1><pre>" + db.status() + "</pre>"
`;

const DJANGO_MANAGE = `#!/usr/bin/env python
import os
import sys


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    from django.core.management import execute_from_command_line
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
`;

function djangoSettings(opts) {
  const lines = [
    'import os',
    'from pathlib import Path',
    '',
    'BASE_DIR = Path(__file__).resolve().parent.parent',
    'SECRET_KEY = "dev-only-change-me"',
    'DEBUG = True',
    '# Local development only. Set real hosts before you put this on a server.',
    'ALLOWED_HOSTS = ["*"]',
    'INSTALLED_APPS = ["django.contrib.contenttypes", "django.contrib.auth"]',
    'MIDDLEWARE = []',
    'ROOT_URLCONF = "config.urls"',
    'WSGI_APPLICATION = "config.wsgi.application"',
    'DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"',
    'USE_TZ = True',
    '',
  ];
  if (opts.mysql) {
    lines.push(
      'import pymysql',
      '',
      'pymysql.version_info = (2, 2, 1, "final", 0)',
      'pymysql.install_as_MySQLdb()',
      'DATABASES = {',
      '    "default": {',
      '        "ENGINE": "django.db.backends.mysql",',
      '        "NAME": os.environ["MYSQL_DATABASE"],',
      '        "USER": os.environ["MYSQL_USER"],',
      '        "PASSWORD": os.environ["MYSQL_PASSWORD"],',
      '        "HOST": os.environ["MYSQL_HOST"],',
      '        "PORT": os.environ["MYSQL_PORT"],',
      '    }',
      '}',
    );
  } else if (opts.postgres) {
    lines.push(
      'DATABASES = {',
      '    "default": {',
      '        "ENGINE": "django.db.backends.postgresql",',
      '        "NAME": os.environ["POSTGRES_DB"],',
      '        "USER": os.environ["POSTGRES_USER"],',
      '        "PASSWORD": os.environ["POSTGRES_PASSWORD"],',
      '        "HOST": os.environ["POSTGRES_HOST"],',
      '        "PORT": os.environ["POSTGRES_PORT"],',
      '    }',
      '}',
    );
  } else {
    lines.push('DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}}');
  }
  lines.push('');
  return lines.join('\n');
}

const DJANGO_URLS = `from django.http import HttpResponse
from django.urls import path

import db


def home(request):
    return HttpResponse("<h1>Hello from Django</h1><pre>" + db.status() + "</pre>")


urlpatterns = [path("", home)]
`;

const DJANGO_WSGI = `import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
application = get_wsgi_application()
`;

// The files of a starter project, as { relative path: text }.
function frameworkFiles(framework, opts) {
  const options = opts || {};
  const files = {
    'requirements.txt': packagesFor(framework, options).join('\n') + '\n',
    'db.py': dbModule(options),
  };
  if (framework === 'flask') files['app.py'] = FLASK_APP;
  if (framework === 'fastapi') files['main.py'] = FASTAPI_APP;
  if (framework === 'django') {
    files['manage.py'] = DJANGO_MANAGE;
    files['config/__init__.py'] = '';
    files['config/settings.py'] = djangoSettings(options);
    files['config/urls.py'] = DJANGO_URLS;
    files['config/wsgi.py'] = DJANGO_WSGI;
  }
  return files;
}

// Environment for the app container, so it can reach the databases that were ticked.
// `creds` = { user, name, password (app user), rootPassword }.
function databaseEnv(opts, creds) {
  const env = {};
  if (opts.mysql) {
    Object.assign(env, { MYSQL_HOST: 'mysql', MYSQL_PORT: '3306', MYSQL_DATABASE: creds.name, MYSQL_USER: creds.user, MYSQL_PASSWORD: creds.password });
  }
  if (opts.postgres) {
    Object.assign(env, { POSTGRES_HOST: 'postgres', POSTGRES_PORT: '5432', POSTGRES_DB: creds.name, POSTGRES_USER: creds.user, POSTGRES_PASSWORD: creds.password });
  }
  if (opts.mongodb) {
    env.MONGODB_URL = `mongodb://root:${creds.rootPassword}@mongodb:27017/?authSource=admin`;
  }
  return env;
}

module.exports = { FRAMEWORKS, FRAMEWORK_KEYS, normalizeFramework, frameworkFiles, frameworkCommand, databaseEnv };
