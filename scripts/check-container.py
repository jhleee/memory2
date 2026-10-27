"""Smoke-test a built image using disposable synthetic data and Docker resources."""
import argparse
import json
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', default='memory2:chatgpt')
parser.add_argument('--docker-host', help='Optional explicit Docker daemon selector')
args = parser.parse_args()
docker = ['docker'] + ([f'--host={args.docker_host}'] if args.docker_host else [])


def run(command, check=True):
    result = subprocess.run(docker + command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if check and result.returncode:
        raise RuntimeError(result.stdout)
    return result.stdout.strip()


volume = run(['volume', 'create', '--label', 'memory2.test=chatgpt'])
container = None
try:
    mount = f'type=volume,src={volume},dst=/data'
    seed = json.loads(run(['run', '--rm', '--mount', mount, args.image, 'node', 'dist/scripts/rpg-seed.js']))
    game = seed['game_id']
    probe = """
import { Memory } from './dist/src/memory.js';
if (process.getuid() === 0) throw Error('Container must run without root');
const memory = new Memory('/data/rpg.db');
if (!memory.db.prepare('SELECT id FROM games WHERE id=?').get(process.argv[1]))
  throw Error('Persisted game was lost');
memory.close();
"""
    run(['run', '--rm', '--mount', mount, args.image, 'node', '--input-type=module', '-e', probe, game])
    container = run(['run', '-d', '--mount', mount,
                     '-e', 'OIDC_ISSUER=https://idp.example/',
                     '-e', 'OIDC_AUDIENCE=https://rpg.example/mcp',
                     '-e', 'OIDC_JWKS_URL=https://idp.example/jwks', args.image])
    check = """
const base = 'http://127.0.0.1:3000';
if (!(await fetch(base + '/health')).ok) throw Error('Health check failed');
const metadata = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json();
if (metadata.resource !== 'https://rpg.example/mcp') throw Error('Invalid resource metadata');
const response = await fetch(base + '/mcp', { method: 'POST', body: '{}' });
if (response.status !== 401 || !response.headers.get('www-authenticate').includes('scope="rpg"'))
  throw Error('Missing OAuth challenge');
"""

    def ready():
        for attempt in range(20):
            try:
                run(['exec', container, 'node', '--input-type=module', '-e', check])
                return
            except RuntimeError:
                if attempt == 19:
                    raise
                time.sleep(.25)

    ready()
    run(['restart', container])
    ready()
    run(['exec', container, 'node', '--input-type=module', '-e', probe, game])
    print(json.dumps({'non_root': 'passed', 'persistent_volume': 'passed',
                      'restart_preserves_game': 'passed', 'oauth_metadata_and_401': 'passed'}))
finally:
    if container:
        run(['rm', '-f', container], check=False)
    run(['volume', 'rm', volume], check=False)
