import json
import os
import re
import select
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parent

def load_env():
    path = ROOT / '.env'
    if path.exists():
        for raw in path.read_text().splitlines():
            raw = raw.strip()
            if raw and not raw.startswith('#') and '=' in raw:
                key, value = raw.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip())

load_env()
MODE = os.getenv('DL_MODE', 'demo').lower()
DOMAIN = os.getenv('MAIL_DOMAIN', 'slalom.com').lower()
TENANT_ID = os.getenv('TENANT_ID', '')
SPA_CLIENT_ID = os.getenv('SPA_CLIENT_ID', '')
API_CLIENT_ID = os.getenv('API_CLIENT_ID', '')
API_SCOPE = os.getenv('API_SCOPE', '')
EXO_ORGANIZATION = os.getenv('EXO_ORGANIZATION', '')
EXO_AUTH = os.getenv('EXO_AUTH', 'managed_identity')
EMAIL = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
ALIAS = re.compile(r'^[a-z0-9][a-z0-9-]{2,39}$')
GUID = re.compile(r'^[0-9a-fA-F-]{36}$')

class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)

def require(condition, message, status=400):
    if not condition:
        raise ApiError(status, message)

def valid_email(value):
    return isinstance(value, str) and len(value) <= 254 and bool(EMAIL.fullmatch(value))

def now():
    return datetime.now(timezone.utc).isoformat()

def settings_from(data):
    require(isinstance(data, dict), 'Expected list details.')
    out = {}
    if 'displayName' in data:
        value = data['displayName']
        require(isinstance(value, str) and 3 <= len(value.strip()) <= 80, 'Use a list name between 3 and 80 characters.')
        out['displayName'] = value.strip()
    if 'senderPolicy' in data:
        require(data['senderPolicy'] in ('internal', 'anyone', 'specific'), 'Invalid sender policy.')
        out['senderPolicy'] = data['senderPolicy']
    if 'senders' in data:
        value = data['senders']
        require(isinstance(value, list) and len(value) <= 20 and all(valid_email(x) for x in value),
                'Choose up to 20 valid sender addresses.')
        out['senders'] = list(dict.fromkeys(x.lower() for x in value))
    if out.get('senderPolicy') == 'specific':
        require(out.get('senders'), 'Add at least one allowed sender.')
    if 'visible' in data:
        require(type(data['visible']) is bool, 'Invalid address book setting.')
        out['visible'] = data['visible']
    if 'joinPolicy' in data:
        require(data['joinPolicy'] in ('open', 'approval', 'closed'), 'Invalid join policy.')
        out['joinPolicy'] = data['joinPolicy']
    if 'coOwner' in data:
        value = data['coOwner']
        require(value is None or valid_email(value), 'Choose a valid co-owner.')
        out['coOwner'] = value.lower() if value else None
    return out

class Store:
    def __init__(self, path):
        if path != ':memory:':
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS join_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    list_id TEXT NOT NULL,
                    requester_oid TEXT NOT NULL,
                    requester_email TEXT NOT NULL,
                    requester_name TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL,
                    decided_at TEXT,
                    decided_by TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_pending_request
                    ON join_requests(list_id, requester_oid) WHERE status='pending';
                CREATE TABLE IF NOT EXISTS activity (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    list_id TEXT NOT NULL,
                    actor_oid TEXT NOT NULL,
                    actor_name TEXT NOT NULL,
                    action TEXT NOT NULL,
                    detail TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
            """)
    def audit(self, list_id, actor, action, detail):
        with self.lock:
            self.db.execute('INSERT INTO activity(list_id,actor_oid,actor_name,action,detail,created_at) VALUES(?,?,?,?,?,?)',
                (list_id, actor['oid'], actor['name'], action, detail, now()))
            self.db.commit()
    def activities(self, actor_oid):
        with self.lock:
            rows = self.db.execute('SELECT * FROM activity WHERE actor_oid=? ORDER BY id DESC LIMIT 30', (actor_oid,)).fetchall()
        return [dict(row) for row in rows]
    def request(self, list_id, actor):
        with self.lock:
            existing = self.db.execute('SELECT id FROM join_requests WHERE list_id=? AND requester_oid=? AND status=?',
                (list_id, actor['oid'], 'pending')).fetchone()
            if existing:
                return existing['id']
            cur = self.db.execute('INSERT INTO join_requests(list_id,requester_oid,requester_email,requester_name,created_at) VALUES(?,?,?,?,?)',
                (list_id, actor['oid'], actor['email'], actor['name'], now()))
            self.db.commit()
            return cur.lastrowid
    def requests_for(self, owned):
        if not owned:
            return []
        with self.lock:
            rows = self.db.execute("SELECT * FROM join_requests WHERE status='pending' ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows if r['list_id'] in owned]
    def has_pending(self, list_id, actor_oid):
        with self.lock:
            row = self.db.execute('SELECT 1 FROM join_requests WHERE list_id=? AND requester_oid=? AND status=?',
                (list_id, actor_oid, 'pending')).fetchone()
        return bool(row)
    def get_request(self, request_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM join_requests WHERE id=?', (request_id,)).fetchone()
        return dict(row) if row else None
    def decide(self, request_id, actor, decision):
        with self.lock:
            self.db.execute('UPDATE join_requests SET status=?,decided_at=?,decided_by=? WHERE id=? AND status=?',
                (decision, now(), actor['oid'], request_id, 'pending'))
            self.db.commit()

class DemoGateway:
    def __init__(self):
        self.lock = threading.Lock()
        self.people = [
            dict(name='Avery Morgan', email='avery.morgan@slalom.com', oid='demo-avery'),
            dict(name='Jordan Lee', email='jordan.lee@slalom.com', oid='demo-jordan'),
            dict(name='Priya Patel', email='priya.patel@slalom.com', oid='demo-priya'),
            dict(name='Marcus Johnson', email='marcus.johnson@slalom.com', oid='demo-marcus'),
            dict(name='Sofia Ramirez', email='sofia.ramirez@slalom.com', oid='demo-sofia'),
            dict(name='Taylor Brooks', email='taylor.brooks@slalom.com', oid='demo-taylor'),
        ]
        self.groups = [
            dict(id='chicago-book-club@slalom.com', displayName='Chicago Book Club', alias='chicago-book-club', senderPolicy='internal', senders=[], visible=True, joinPolicy='approval', departOpen=True, owners=['avery.morgan@slalom.com'], members=['jordan.lee@slalom.com', 'priya.patel@slalom.com', 'marcus.johnson@slalom.com'], synced=False),
            dict(id='tech-support-leads@slalom.com', displayName='Tech Support Leads', alias='tech-support-leads', senderPolicy='internal', senders=[], visible=True, joinPolicy='closed', departOpen=False, owners=['avery.morgan@slalom.com'], members=['avery.morgan@slalom.com', 'taylor.brooks@slalom.com'], synced=False),
            dict(id='atl-lunch-learn@slalom.com', displayName='ATL Lunch & Learn', alias='atl-lunch-learn', senderPolicy='anyone', senders=[], visible=True, joinPolicy='open', departOpen=True, owners=['priya.patel@slalom.com'], members=['jordan.lee@slalom.com', 'sofia.ramirez@slalom.com'], synced=False),
            dict(id='design-community@slalom.com', displayName='Design Community', alias='design-community', senderPolicy='internal', senders=[], visible=True, joinPolicy='approval', departOpen=True, owners=['jordan.lee@slalom.com'], members=['marcus.johnson@slalom.com'], synced=False),
            dict(id='chicago-events@slalom.com', displayName='Chicago Events', alias='chicago-events', senderPolicy='internal', senders=[], visible=True, joinPolicy='open', departOpen=True, owners=['sofia.ramirez@slalom.com'], members=['avery.morgan@slalom.com'], synced=False),
        ]
    def person(self, email):
        return next((p for p in self.people if p['email'] == email.lower()), None)
    def group(self, gid):
        group = next((g for g in self.groups if g['id'] == gid.lower()), None)
        require(group is not None, 'List not found.', 404)
        return group
    def summary(self, group, actor):
        return {k: group[k] for k in ('id', 'displayName', 'alias', 'senderPolicy', 'visible', 'joinPolicy', 'departOpen', 'synced')} | {
            'memberCount': len(group['members']),
            'isOwner': actor['email'] in group['owners'],
            'canManage': actor['email'] in group['owners'] and not group['synced'],
            'isMember': actor['email'] in group['members']}
    def call(self, op, actor, data):
        with self.lock:
            if op == 'me':
                return {'name': actor['name'], 'email': actor['email']}
            if op == 'owned':
                return [self.summary(g, actor) for g in self.groups if actor['email'] in g['owners']]
            if op == 'joined':
                return [self.summary(g, actor) for g in self.groups if actor['email'] in g['members']]
            if op == 'discover':
                q = data.get('q', '').lower()
                return [self.summary(g, actor) for g in self.groups if g['visible'] and g['joinPolicy'] in ('open', 'approval') and actor['email'] not in g['owners'] and actor['email'] not in g['members'] and q in (g['displayName'] + g['id']).lower()]
            if op == 'alias':
                return {'available': not any(g['alias'] == data['alias'] for g in self.groups)}
            if op == 'directory':
                q = data.get('q', '').lower()
                return [dict(name=p['name'], email=p['email']) for p in self.people if q and q in (p['name'] + p['email']).lower()][:8]
            if op == 'get':
                g = self.group(data['id'])
                result = self.summary(g, actor) | {'owners': list(g['owners'])}
                if result['canManage']:
                    result['members'] = [dict(name=(self.person(e) or {'name': e})['name'], email=e) for e in g['members']]
                    result['senders'] = list(g['senders'])
                return result
            if op == 'create':
                alias = data['alias']
                require(not any(g['alias'] == alias for g in self.groups), 'That address is already in use.', 409)
                for email in data['members'] + data.get('senders', []) + ([data['coOwner']] if data.get('coOwner') else []):
                    require(self.person(email) is not None, 'A selected person is not in the directory.')
                g = dict(id=alias + '@' + DOMAIN, displayName=data['displayName'], alias=alias,
                    senderPolicy=data['senderPolicy'], senders=data.get('senders', []), visible=data['visible'],
                    joinPolicy=data['joinPolicy'], departOpen=True,
                    owners=[actor['email']] + ([data['coOwner']] if data.get('coOwner') else []),
                    members=list(data['members']), synced=False)
                self.groups.insert(0, g)
                return self.summary(g, actor) | {'warnings': []}
            if op in ('update', 'add_owner', 'add_member', 'remove_member', 'approve_request'):
                g = self.group(data['id'])
                require(actor['email'] in g['owners'] and not g['synced'], 'Only an owner can change this list.', 403)
                if op == 'add_owner':
                    email = data['email'].lower()
                    require(self.person(email), 'Person not found in the directory.')
                    require(email not in g['owners'], 'This person is already an owner.', 409)
                    g['owners'].append(email)
                elif op == 'update':
                    if 'displayName' in data: g['displayName'] = data['displayName']
                    if 'senderPolicy' in data: g['senderPolicy'] = data['senderPolicy']
                    if 'senders' in data: g['senders'] = data['senders']
                    if 'visible' in data: g['visible'] = data['visible']
                    if 'joinPolicy' in data: g['joinPolicy'] = data['joinPolicy']
                    if data.get('coOwner'):
                        require(self.person(data['coOwner']), 'Co-owner not found.')
                        if data['coOwner'] not in g['owners']:
                            g['owners'].append(data['coOwner'])
                else:
                    email = data['email'].lower()
                    require(self.person(email), 'Person not found in the directory.')
                    if op in ('add_member', 'approve_request') and email not in g['members']:
                        g['members'].append(email)
                    if op == 'remove_member' and email in g['members']:
                        g['members'].remove(email)
                return self.summary(g, actor)
            if op == 'membership':
                g = self.group(data['id'])
                email = actor['email']
                if data['action'] == 'join':
                    require(g['joinPolicy'] != 'closed', 'This list is closed to self-service joining.', 403)
                    if email in g['members']:
                        return {'joined': True}
                    if g['joinPolicy'] == 'approval':
                        return {'approvalRequired': True}
                    g['members'].append(email)
                    return {'joined': True}
                require(g['departOpen'], 'Only an owner can remove members from this list.', 403)
                if email in g['members']:
                    g['members'].remove(email)
                return {'joined': False}
            raise ApiError(400, 'Unknown operation.')

class ExchangeBridge:
    def __init__(self):
        self.lock, self.proc = threading.Lock(), None
    def call(self, op, actor, data):
        with self.lock:
            for attempt in range(2):
                if self.proc is None or self.proc.poll() is not None:
                    self.proc = subprocess.Popen(
                        ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(ROOT / 'exchange.ps1')],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        text=True, bufsize=1, env=os.environ.copy())
                try:
                    self.proc.stdin.write(json.dumps({'op': op, 'actor': actor, 'data': data}) + '\n')
                    self.proc.stdin.flush()
                    deadline = time.monotonic() + 90
                    while time.monotonic() < deadline:
                        ready, _, _ = select.select([self.proc.stdout], [], [], max(0, deadline - time.monotonic()))
                        if not ready:
                            break
                        line = self.proc.stdout.readline()
                        if not line:
                            raise RuntimeError('Exchange connector stopped.')
                        if line.startswith('DLSTUDIO_JSON:'):
                            answer = json.loads(line[len('DLSTUDIO_JSON:'):])
                            if not answer.get('ok'):
                                raise ApiError(answer.get('status', 502), answer.get('error', 'Exchange operation failed.'))
                            return answer.get('data')
                    raise RuntimeError('Exchange connector timed out.')
                except ApiError:
                    raise
                except (BrokenPipeError, OSError, RuntimeError):
                    if self.proc and self.proc.poll() is None:
                        self.proc.kill()
                    self.proc = None
                    if attempt:
                        raise ApiError(503, 'Exchange is unavailable. Please try again.')
            raise ApiError(503, 'Exchange is unavailable.')

def validate_live_config():
    require(all((TENANT_ID, SPA_CLIENT_ID, API_CLIENT_ID, API_SCOPE, EXO_ORGANIZATION)),
            'Live mode requires all Entra and Exchange settings.', 500)
    require(all(GUID.fullmatch(x) for x in (TENANT_ID, SPA_CLIENT_ID, API_CLIENT_ID)),
            'Use GUIDs for tenant and app IDs.', 500)
    require(EXO_AUTH in ('managed_identity', 'certificate'), 'Invalid EXO_AUTH setting.', 500)
    if EXO_AUTH == 'certificate':
        require(all(os.getenv(k) for k in ('EXO_APP_ID', 'EXO_CERT_PATH', 'EXO_CERT_PASSWORD')),
                'Certificate mode requires EXO_APP_ID, EXO_CERT_PATH, and EXO_CERT_PASSWORD.', 500)

if MODE == 'live':
    validate_live_config()
elif MODE != 'demo':
    raise RuntimeError('DL_MODE must be demo or live.')
gateway = DemoGateway() if MODE == 'demo' else ExchangeBridge()
store = Store(':memory:' if MODE == 'demo' else str(ROOT / os.getenv('DB_PATH', 'data/dl-studio.sqlite')))
if MODE == 'demo':
    store.request('chicago-book-club@slalom.com', gateway.people[4])
_jwk_client = None
_actor_cache = {}
_actor_lock = threading.Lock()

def actor_from_header(header):
    if MODE == 'demo':
        return gateway.people[0]
    require(header and header.startswith('Bearer '), 'Sign in to continue.', 401)
    global _jwk_client
    try:
        import jwt
        from jwt import PyJWKClient
        if _jwk_client is None:
            _jwk_client = PyJWKClient('https://login.microsoftonline.com/' + TENANT_ID + '/discovery/v2.0/keys')
        token = header[7:]
        key = _jwk_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(token, key.key, algorithms=['RS256'], audience=API_CLIENT_ID,
            issuer='https://login.microsoftonline.com/' + TENANT_ID + '/v2.0',
            options={'require': ['exp', 'iat', 'iss', 'aud', 'tid', 'oid']})
        require(claims.get('tid') == TENANT_ID, 'Wrong tenant.', 401)
        require(API_SCOPE.rsplit('/', 1)[-1] in claims.get('scp', '').split(), 'Missing app permission.', 403)
        require(claims.get('azp') == SPA_CLIENT_ID, 'Unrecognized client app.', 401)
        oid = claims['oid']
        require(GUID.fullmatch(oid), 'Invalid user identity.', 401)
        with _actor_lock:
            cached = _actor_cache.get(oid)
            if cached and cached[1] > time.time():
                return cached[0]
        identity = gateway.call('me', {'oid': oid}, {})
        actor = {'oid': oid, 'name': identity['name'], 'email': identity['email']}
        with _actor_lock:
            _actor_cache[oid] = (actor, time.time() + 300)
        return actor
    except ApiError:
        raise
    except Exception:
        raise ApiError(401, 'Your sign-in expired. Please sign in again.')

def owned_ids(actor):
    return {g['id'].lower() for g in gateway.call('owned', actor, {})}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print('%s %s' % (self.address_string(), fmt % args), flush=True)
    def common_headers(self, api=False):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        ancestors = os.getenv('FRAME_ANCESTORS', "'self'")
        self.send_header('Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "connect-src 'self' https://login.microsoftonline.com; form-action 'self' https://login.microsoftonline.com; "
            'frame-ancestors ' + ancestors)
        if api:
            self.send_header('Cache-Control', 'no-store')
    def send_json(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.common_headers(True)
        self.end_headers()
        self.wfile.write(raw)
    def send_file(self, name):
        path = ROOT / name
        require(path.exists(), 'Page not found.', 404)
        raw = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', {'index.html': 'text/html', 'styles.css': 'text/css', 'app.js': 'text/javascript'}[name] + '; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.common_headers()
        self.end_headers()
        self.wfile.write(raw)
    def body(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise ApiError(400, 'Invalid request length.')
        require(0 < size <= 1048576, 'Request body is too large or empty.', 413)
        try:
            return json.loads(self.rfile.read(size))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, 'Invalid JSON.')
    def handle_any(self):
        parsed, method = urlsplit(self.path), self.command
        path = parsed.path
        if method == 'GET' and path in ('/', '/index.html', '/styles.css', '/app.js'):
            return self.send_file('index.html' if path == '/' else path[1:])
        if method == 'GET' and path == '/api/config':
            return self.send_json(200, {'mode': MODE, 'mailDomain': DOMAIN, 'tenantId': TENANT_ID,
                'spaClientId': SPA_CLIENT_ID, 'apiScope': API_SCOPE})
        require(path.startswith('/api/'), 'Page not found.', 404)
        actor = actor_from_header(self.headers.get('Authorization'))
        query = parse_qs(parsed.query)
        data = self.body() if method in ('POST', 'PATCH', 'DELETE') else {}
        result, status = None, 200
        if method == 'GET' and path == '/api/me':
            result = gateway.call('me', actor, {})
        elif method == 'GET' and path == '/api/lists':
            scope = query.get('scope', ['owned'])[0]
            require(scope in ('owned', 'discover', 'joined'), 'Invalid list scope.')
            result = gateway.call(scope, actor, {'q': query.get('q', [''])[0][:80]})
        elif method == 'GET' and path == '/api/alias':
            alias = query.get('value', [''])[0].lower()
            require(ALIAS.fullmatch(alias), 'Use 3 to 40 lowercase letters, numbers, or dashes.')
            result = gateway.call('alias', actor, {'alias': alias})
        elif method == 'GET' and path == '/api/directory':
            q = query.get('q', [''])[0].strip()
            require(2 <= len(q) <= 80, 'Enter at least 2 characters.')
            result = gateway.call('directory', actor, {'q': q})
        elif method == 'GET' and path == '/api/requests':
            result = store.requests_for(owned_ids(actor))
        elif method == 'GET' and path == '/api/activity':
            result = store.activities(actor['oid'])
        elif method == 'POST' and path == '/api/lists':
            require(isinstance(data, dict), 'Expected list details.')
            alias = str(data.get('alias', '')).lower()
            require(ALIAS.fullmatch(alias), 'Use 3 to 40 lowercase letters, numbers, or dashes.')
            settings = settings_from(data)
            require(all(k in settings for k in ('displayName', 'senderPolicy', 'visible', 'joinPolicy')), 'Complete all list settings.')
            members = data.get('members', [])
            require(isinstance(members, list) and len(members) <= 500 and all(valid_email(x) for x in members),
                    'Add up to 500 valid member addresses.')
            payload = settings | {'alias': alias, 'members': list(dict.fromkeys(x.lower() for x in members))}
            result = gateway.call('create', actor, payload)
            status = 201
            store.audit(result['id'], actor, 'created', result['displayName'])
        else:
            list_match = re.fullmatch(r'/api/lists/([^/]+)(?:/(members|membership|owners)(?:/([^/]+))?)?', path)
            request_match = re.fullmatch(r'/api/requests/([0-9]+)', path)
            if list_match:
                gid = unquote(list_match.group(1)).lower()
                require(valid_email(gid), 'Invalid list address.')
                part, member = list_match.group(2), unquote(list_match.group(3) or '').lower()
                if method == 'GET' and not part:
                    result = gateway.call('get', actor, {'id': gid})
                    result['joinPending'] = store.has_pending(gid, actor['oid'])
                elif method == 'PATCH' and not part:
                    settings = settings_from(data)
                    require(settings, 'Nothing to update.')
                    result = gateway.call('update', actor, {'id': gid} | settings)
                    store.audit(gid, actor, 'settings updated', ', '.join(settings))
                elif method == 'POST' and part == 'owners' and not member:
                    require(isinstance(data, dict) and valid_email(data.get('email')), 'Enter a valid owner address.')
                    email = data['email'].lower()
                    result = gateway.call('add_owner', actor, {'id': gid, 'email': email})
                    store.audit(gid, actor, 'owner added', email)
                elif method == 'POST' and part == 'members' and not member:
                    require(valid_email(data.get('email')), 'Enter a valid member address.')
                    result = gateway.call('add_member', actor, {'id': gid, 'email': data['email'].lower()})
                    store.audit(gid, actor, 'member added', data['email'].lower())
                elif method == 'DELETE' and part == 'members' and member:
                    require(valid_email(member), 'Invalid member address.')
                    result = gateway.call('remove_member', actor, {'id': gid, 'email': member})
                    store.audit(gid, actor, 'member removed', member)
                elif method == 'POST' and part == 'membership':
                    require(data.get('action') in ('join', 'leave'), 'Choose join or leave.')
                    result = gateway.call('membership', actor, {'id': gid, 'action': data['action']})
                    if result.get('approvalRequired'):
                        request_id = store.request(gid, actor)
                        result = {'requested': True, 'requestId': request_id}
                        store.audit(gid, actor, 'join requested', actor['email'])
                    else:
                        store.audit(gid, actor, 'joined' if data['action'] == 'join' else 'left', actor['email'])
                else:
                    raise ApiError(404, 'Endpoint not found.')
            elif request_match and method == 'POST':
                request_id = int(request_match.group(1))
                request = store.get_request(request_id)
                require(request and request['status'] == 'pending', 'Request not found.', 404)
                require(request['list_id'] in owned_ids(actor), 'Only a list owner can decide this request.', 403)
                decision = data.get('decision')
                require(decision in ('approved', 'declined'), 'Choose approve or decline.')
                if decision == 'approved':
                    gateway.call('approve_request', actor, {'id': request['list_id'], 'email': request['requester_email']})
                store.decide(request_id, actor, decision)
                store.audit(request['list_id'], actor, 'join ' + decision, request['requester_email'])
                result = {'status': decision}
            else:
                raise ApiError(404, 'Endpoint not found.')
        return self.send_json(status, result)
    def dispatch(self):
        try:
            self.handle_any()
        except ApiError as e:
            self.send_json(e.status, {'error': e.message})
        except Exception as e:
            print('Server error:', repr(e), flush=True)
            self.send_json(500, {'error': 'Something went wrong. Please try again.'})
    def do_GET(self): self.dispatch()
    def do_POST(self): self.dispatch()
    def do_PATCH(self): self.dispatch()
    def do_DELETE(self): self.dispatch()

if __name__ == '__main__':
    host, port = os.getenv('HOST', '127.0.0.1'), int(os.getenv('PORT', '8787'))
    print(f'DL Studio ({MODE}) at http://{host}:{port}', flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
