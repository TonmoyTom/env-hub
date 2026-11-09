'use strict';

// Everything the "Links & commands" panel shows for one project: each service with its image,
// start command, web addresses and a shell command, plus the Docker commands for the whole project.
// Pure: it only builds text. Nothing is run here.

const PLAIN_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

function quoteArg(arg) {
  return PLAIN_ARG.test(arg) ? arg : `"${arg.replace(/(["\\])/g, '\\$1')}"`;
}

// ['sh', '-c', 'npm install && npm run dev'] -> sh -c "npm install && npm run dev"
function commandText(command) {
  return Array.isArray(command) ? command.map((arg) => quoteArg(String(arg))).join(' ') : '';
}

function buildLinks({ name, config, ports, composeFile, running, lan = {} }) {
  const container = (service) => `envhub-${name}-${service}`;
  const compose = `docker compose -f "${composeFile}" -p envhub-${name}`;

  const services = config.services.map((svc) => ({
    name: svc.name,
    image: svc.image,
    container: container(svc.name),
    command: commandText(svc.command),
    shell: `docker exec -it ${container(svc.name)} sh`,
    ports: ports
      .filter((p) => p.service === svc.name)
      .map((p) => ({
        container: p.container,
        host: p.host,
        url: `http://localhost:${p.host}`,
        // Addresses for other computers on the same network, only for the shared web page.
        lanUrls: lan.enabled && lan.service === svc.name ? lan.addresses.map((a) => `http://${a}:${p.host}`) : [],
      })),
  }));

  const commands = [
    { label: 'Show the logs live', text: `${compose} logs -f` },
    { label: 'List the containers', text: `docker ps --filter label=com.envhub.project=${name}` },
    { label: 'Stop the project', text: `${compose} stop` },
    { label: 'Start it again', text: `${compose} up -d` },
    { label: 'Remove the containers', text: `${compose} down` },
  ];

  return { name, running: running === true, lanShare: Boolean(lan.enabled), lanFound: Boolean(lan.enabled) && lan.addresses.length > 0, services, commands };
}

module.exports = { buildLinks, commandText };
