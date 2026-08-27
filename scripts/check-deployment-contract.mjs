import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8');
const required = (value, needle, label) => {
  if (!value.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};
const forbidden = (value, needle, label) => {
  if (value.includes(needle)) throw new Error(`${label}: unexpected ${needle}`);
};

const workflow = read('.github/workflows/ci.yml');
required(workflow, 'type=raw,value=edge,enable=${{ github.ref == \'refs/heads/master\' }}', 'workflow');
required(workflow, 'type=sha,prefix=sha-,format=long', 'workflow');
required(workflow, 'type=semver,pattern={{version}},enable=${{ startsWith(github.ref, \'refs/tags/v\') }}', 'workflow');
required(workflow, 'type=semver,pattern={{major}}.{{minor}},enable=${{ startsWith(github.ref, \'refs/tags/v\') }}', 'workflow');
required(workflow, 'type=semver,pattern={{major}},enable=${{ startsWith(github.ref, \'refs/tags/v\') }}', 'workflow');
required(workflow, 'type=raw,value=latest,enable=${{ startsWith(github.ref, \'refs/tags/v\') }}', 'workflow');
forbidden(workflow, 'type=raw,value=latest,enable=${{ github.ref == \'refs/heads/master\' }}', 'workflow');
required(workflow, 'needs: [test, migration, e2e, image]', 'publish gate');
required(workflow, 'platforms: linux/amd64,linux/arm64', 'publish platforms');
required(workflow, 'provenance: mode=max', 'publish provenance');
required(workflow, 'sbom: true', 'publish SBOM');
required(workflow, 'docker run -d --name minepanel-release-smoke', 'trusted smoke');

const compose = read('docker-compose.yml');
required(compose, 'image: ${MINEPANEL_IMAGE:-ghcr.io/minepanelproject/minepanel-backend:latest}', 'compose image');
required(compose, 'pull_policy: missing', 'compose pull policy');
required(compose, 'MINEPANEL_IMAGE', 'compose override');

for (const relativePath of ['README.md', 'docs/deployment.md']) {
  const docs = read(relativePath);
  required(docs, 'raw.githubusercontent.com/MinePanelProject/minepanel-backend', `${relativePath} asset URLs`);
  required(docs, 'edge', `${relativePath} edge channel`);
  required(docs, 'stable', `${relativePath} stable channel`);
  required(docs, 'docker compose pull', `${relativePath} update command`);
  required(docs, 'pull_policy: missing', `${relativePath} pull policy explanation`);
}

process.stdout.write('deployment/release contract ok\n');
