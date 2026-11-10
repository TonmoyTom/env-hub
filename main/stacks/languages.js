'use strict';

// Known languages for the "Docker image" stack. Picked by the image name (python:3.12, golang:1.23, ...).
// Each one gives: a Dockerfile that installs dependencies, a starter page (so the project shows something),
// and the default start command. Any other image still works with a plain FROM Dockerfile.
const PORT = 8000;

const PYTHON_APP = `import os
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<h1>ProjectDockHub is running</h1><p>Python placeholder</p>")


HTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8000"))), Handler).serve_forever()
`;

const GO_MAIN = `package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<h1>ProjectDockHub is running</h1><p>Go placeholder</p>")
	})
	http.ListenAndServe("0.0.0.0:"+port, nil)
}
`;

const RUST_MAIN = `use std::io::{Read, Write};
use std::net::TcpListener;

fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8000".to_string());
    let listener = TcpListener::bind(format!("0.0.0.0:{}", port)).unwrap();
    for stream in listener.incoming() {
        if let Ok(mut s) = stream {
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            let body = "<h1>ProjectDockHub is running</h1><p>Rust placeholder</p>";
            let resp = format!(
                "HTTP/1.1 200 OK\\r\\nContent-Type: text/html\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n{}",
                body.len(),
                body
            );
            let _ = s.write_all(resp.as_bytes());
        }
    }
}
`;

const JAVA_MAIN = `import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;

public class Main {
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8000"));
        HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
        server.createContext("/", exchange -> {
            byte[] body = "<h1>ProjectDockHub is running</h1><p>Java placeholder</p>".getBytes();
            exchange.getResponseHeaders().add("Content-Type", "text/html");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
        });
        server.start();
    }
}
`;

const LANGUAGES = [
  {
    key: 'python',
    match: /^python(:|$)/,
    command: 'python app.py',
    dockerfile: (image) =>
      `FROM ${image}\nWORKDIR /app\nENV PYTHONUNBUFFERED=1\n` +
      `COPY requirements.txt ./\nRUN pip install --no-cache-dir -r requirements.txt\nEXPOSE ${PORT}\n`,
    keep: ['requirements.txt'],
    files: { 'requirements.txt': '# Put your packages here, one per line. Example: flask\n', 'app.py': PYTHON_APP },
  },
  {
    key: 'go',
    match: /^golang(:|$)/,
    command: 'go run .',
    dockerfile: (image) => `FROM ${image}\nWORKDIR /app\nCOPY go.mod ./\nRUN go mod download\nEXPOSE ${PORT}\n`,
    keep: ['go.mod'],
    files: { 'go.mod': 'module app\n\ngo 1.21\n', 'main.go': GO_MAIN },
  },
  {
    key: 'rust',
    match: /^rust(:|$)/,
    command: 'cargo run',
    dockerfile: (image) =>
      `FROM ${image}\nWORKDIR /app\nCOPY Cargo.toml ./\n` +
      `RUN mkdir -p src && echo "fn main() {}" > src/main.rs && cargo fetch\nEXPOSE ${PORT}\n`,
    keep: ['Cargo.toml'],
    files: {
      'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      'src/main.rs': RUST_MAIN,
    },
  },
  {
    key: 'java',
    match: /^(eclipse-temurin|openjdk|amazoncorretto)(:|$)/,
    command: 'javac Main.java && java Main',
    dockerfile: (image) => `FROM ${image}\nWORKDIR /app\nEXPOSE ${PORT}\n`,
    keep: [],
    files: { 'Main.java': JAVA_MAIN },
  },
];

// The language for an image name, or null when the image is not one of the known languages.
function languageOf(image) {
  if (typeof image !== 'string') return null;
  return LANGUAGES.find((lang) => lang.match.test(image.trim())) || null;
}

// Default start command for an image, or '' when there is none.
function languageCommand(image) {
  const lang = languageOf(image);
  return lang ? lang.command : '';
}

module.exports = { LANGUAGES, languageOf, languageCommand, PORT };
