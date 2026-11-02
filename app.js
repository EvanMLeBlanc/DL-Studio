const $ = (id) => document.getElementById(id);
const state = {
  config: null, token: null, expiresAt: 0, me: null, view: 'auth',
  owned: [], discover: [], joined: [], requests: [], activity: [], selected: null,
  detailTab: 'overview', detailOrigin: 'owned', wizard: null, busy: false, discoverQuery: '', ownedQuery: '', joinedQuery: '',
  created: null, csvErrors: [], personQuery: ''
};
let toastTimer;
let aliasTimer;
let searchTimer;

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function initials(value) {
  return String(value || '?').split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('');
}
function avatar(value, cls = '') {
  return `<span class="avatar ${cls}">${escapeHTML(initials(value))}</span>`;
}
function slug(value) {
  return String(value).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value)); }
function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
}
function listPath(id) { return '/api/lists/' + encodeURIComponent(id); }
function setTitle(text) { $('page-title').textContent = text; document.title = text + ' · DL Studio'; }
function showToast(message, error = false) {
  const box = $('toast');
  box.textContent = message;
  box.className = 'toast show' + (error ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.className = 'toast', 4000);
}
function showLoading(message = 'Loading your lists…') {
  $('view').innerHTML = `<div class="loading"><div class="spinner"></div><span>${escapeHTML(message)}</span></div>`;
}
function modal(title, body, confirmLabel, onConfirm, danger = false) {
  const root = $('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <h2 id="modal-title">${escapeHTML(title)}</h2><p>${escapeHTML(body)}</p>
    <div class="modal-actions"><button class="btn btn-outline" id="modal-cancel" type="button">Cancel</button>
    <button class="btn ${danger ? 'btn-danger' : 'btn-violet'}" id="modal-confirm" type="button">${escapeHTML(confirmLabel)}</button></div>
  </div></div>`;
  $('modal-cancel').onclick = () => root.innerHTML = '';
  root.querySelector('.modal-backdrop').onclick = (event) => { if (event.target.classList.contains('modal-backdrop')) root.innerHTML = ''; };
  $('modal-confirm').onclick = async () => {
    root.innerHTML = '';
    await onConfirm();
  };
}
async function api(path, method = 'GET', body) {
  const headers = {'Accept':'application/json'};
  if (state.config?.mode === 'live' && state.token) headers.Authorization = 'Bearer ' + state.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache:'no-store'});
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    if (response.status === 401 && state.config?.mode === 'live') {
      state.token = null;
      sessionStorage.removeItem('dl_studio_token');
      renderAuth();
    }
    throw new Error(payload.error || 'That action could not be completed.');
  }
  return payload;
}
async function init() {
  try {
    state.config = await api('/api/config');
    if (state.config.mode === 'demo') {
      $('mode-pill').style.display = 'inline-flex';
      $('mode-pill').textContent = 'Sample preview';
    }
    const saved = sessionStorage.getItem('dl_studio_token');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.expiresAt > Date.now() + 30000) {
        state.token = parsed.token;
        state.expiresAt = parsed.expiresAt;
      }
    }
    if (location.search.includes('code=') || location.search.includes('error=')) await finishSignIn();
    if (state.token) await enterStudio();
    else renderAuth();
  } catch (error) {
    $('view').innerHTML = `<div class="empty"><span class="big">!</span><strong>DL Studio could not start</strong><p>${escapeHTML(error.message)}</p></div>`;
  }
}
function randomString() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
}
async function challenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
}
async function startSignIn() {
  if (window.top !== window.self) {
    window.open(location.origin + '/', '_blank', 'noopener');
    return;
  }
  const verifier = randomString();
  const stateValue = randomString();
  sessionStorage.setItem('dl_studio_pkce', JSON.stringify({verifier, state:stateValue}));
  const params = new URLSearchParams({
    client_id:state.config.spaClientId, response_type:'code', response_mode:'query',
    redirect_uri:location.origin + '/', scope:'openid profile email ' + state.config.apiScope,
    state:stateValue, code_challenge:await challenge(verifier), code_challenge_method:'S256'
  });
  location.assign('https://login.microsoftonline.com/' + encodeURIComponent(state.config.tenantId) + '/oauth2/v2.0/authorize?' + params);
}
async function finishSignIn() {
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  history.replaceState(null, '', location.pathname);
  if (error) throw new Error(params.get('error_description') || error);
  const pending = JSON.parse(sessionStorage.getItem('dl_studio_pkce') || 'null');
  sessionStorage.removeItem('dl_studio_pkce');
  if (!pending || pending.state !== params.get('state')) throw new Error('Sign-in state did not match. Please try again.');
  const form = new URLSearchParams({
    client_id:state.config.spaClientId, grant_type:'authorization_code',
    code:params.get('code'), redirect_uri:location.origin + '/',
    code_verifier:pending.verifier, scope:state.config.apiScope
  });
  const response = await fetch('https://login.microsoftonline.com/' + encodeURIComponent(state.config.tenantId) + '/oauth2/v2.0/token',
    {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});
  const token = await response.json();
  if (!response.ok || !token.access_token) throw new Error(token.error_description || 'Sign-in could not be completed.');
  state.token = token.access_token;
  state.expiresAt = Date.now() + (token.expires_in || 3600) * 1000;
  sessionStorage.setItem('dl_studio_token', JSON.stringify({token:state.token, expiresAt:state.expiresAt}));
}
function renderAuth() {
  state.view = 'auth';
  setTitle('Welcome');
  $('nav').innerHTML = '';
  $('profile').innerHTML = '';
  const demo = state.config?.mode === 'demo';
  const embedded = !demo && window.top !== window.self;
  $('view').innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <div class="auth-logo" aria-hidden="true">slalom</div>
    <p class="eyebrow">YOUR LISTS, YOUR WAY</p>
    <h1>Welcome to DL Studio</h1>
    <p>Create a distribution list, look after the ones you own, or find a list to join. Everything is in one simple workspace.</p>
    <button class="btn btn-primary" id="sign-in" type="button">${demo ? 'Explore sample studio' : embedded ? 'Open DL Studio to sign in' : 'Sign in with Microsoft SSO'} <span aria-hidden="true">→</span></button>
    <div class="auth-foot">${demo ? 'Sample preview. Changes affect sample data only and do not reach Exchange.' : embedded ? 'Microsoft sign-in opens in a new tab when the studio is embedded.' : 'Use your work account. Your organization’s Microsoft sign-in handles authentication.'}</div>
  </div></div>`;
  $('sign-in').onclick = demo ? async () => { state.token = 'demo'; await enterStudio(); } : startSignIn;
}
async function enterStudio() {
  showLoading('Opening your workspace…');
  try {
    state.me = await api('/api/me');
    updateProfile();
    state.view = 'home';
    renderNav();
    await loadHome();
  } catch (error) {
    showToast(error.message, true);
    if (!state.me) renderAuth();
  }
}
function signOut() {
  state.token = null;
  state.me = null;
  sessionStorage.removeItem('dl_studio_token');
  renderAuth();
}
function updateProfile() {
  $('profile').innerHTML = avatar(state.me.name) + `<div><strong>${escapeHTML(state.me.name)}</strong><small>${escapeHTML(state.me.email)}</small></div><button class="signout" id="signout" type="button">${state.config.mode === 'demo' ? 'Exit preview' : 'Sign out'}</button>`;
  $('signout').onclick = signOut;
}
const navItems = [
  ['home','⌂','Home'],['create','＋','Create a list'],['owned','▤','Lists I own'],
  ['discover','↗','Join a list'],['joined','↙','Leave a list'],
  ['requests','◷','Requests'],['activity','◌','Activity']
];
function renderNav() {
  $('nav').innerHTML = navItems.map(([key, icon, label]) => `<button type="button" class="nav-button ${state.view === key || (state.view === 'detail' && key === state.detailOrigin) ? 'active' : ''}" data-view="${key}">
    <span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span>${key === 'requests' && state.requests.length ? `<span class="nav-count">${state.requests.length}</span>` : ''}
  </button>`).join('');
  $('nav').querySelectorAll('[data-view]').forEach((button) => button.onclick = () => navigate(button.dataset.view));
  $('menu-button').onclick = () => {
    const isOpen = $('sidebar').classList.toggle('open');
    $('menu-button').setAttribute('aria-expanded', String(isOpen));
  };
}
async function navigate(view) {
  $('sidebar').classList.remove('open');
  $('menu-button').setAttribute('aria-expanded', 'false');
  state.view = view;
  state.selected = null;
  renderNav();
  if (view === 'home') await loadHome();
  else if (view === 'create') {
    state.wizard = freshWizard();
    renderWizard();
  } else if (view === 'owned') await loadOwned();
  else if (view === 'discover') await loadDiscover();
  else if (view === 'joined') await loadJoined();
  else if (view === 'requests') await loadRequests();
  else if (view === 'activity') await loadActivity();
}
async function refreshOwned() {
  state.owned = await api('/api/lists?scope=owned');
  renderNav();
}
async function refreshRequests() {
  state.requests = await api('/api/requests');
  renderNav();
}
async function refreshJoined() {
  state.joined = await api('/api/lists?scope=joined');
}
async function loadHome() {
  setTitle('Home');
  if (!state.owned.length && !state.joined.length && !state.requests.length) showLoading();
  try {
    await Promise.all([refreshOwned(), refreshJoined(), refreshRequests()]);
    renderHome();
  } catch (error) { showToast(error.message, true); renderHome(); }
}
function renderHome() {
  setTitle('Home');
  const first = state.me.name.split(' ')[0];
  $('view').innerHTML = `<div class="hero-panel">
    <div><p class="eyebrow">YOUR SLALOM LIST WORKSPACE</p><h1>Good to see you, ${escapeHTML(first)}.</h1>
    <p>Create a list, keep your communities current, and choose the conversations you want to join.</p>
    <div class="hero-actions"><button class="btn btn-primary" id="hero-create">＋ Create a new list</button><button class="btn btn-white" id="hero-discover">Find a list to join</button></div></div>
    <div class="hero-graphic" aria-hidden="true"><span>slalom</span></div>
  </div>
  <div class="stats-grid">
    <div class="stat-card"><span class="stat-icon">▤</span><div><strong>${state.owned.length}</strong><small>Lists you own</small></div></div>
    <div class="stat-card"><span class="stat-icon joined-stat">✓</span><div><strong>${state.joined.length}</strong><small>Lists you are in</small></div></div>
    <div class="stat-card"><span class="stat-icon request-stat">◷</span><div><strong>${state.requests.length}</strong><small>Requests to review</small></div></div>
  </div>
  <div class="section-title"><div><h2>What would you like to do?</h2><p>Choose a task to get started.</p></div></div>
  <div class="card-grid">
    <button class="action-card" id="action-create"><span class="action-icon purple">＋</span><h3>Create a new list</h3><p>Start a list for a team, event, community, or project.</p><span class="arrow-link">Get started →</span></button>
    <button class="action-card" id="action-owned"><span class="action-icon cyan">▤</span><h3>Manage a list I own</h3><p>Update members, owners, settings, and join requests.</p><span class="arrow-link">See lists I own →</span></button>
    <button class="action-card" id="action-discover"><span class="action-icon gold">↗</span><h3>Join a list</h3><p>Find a list you are not in and join or request access.</p><span class="arrow-link">Browse lists →</span></button>
    <button class="action-card" id="action-joined"><span class="action-icon leave">↙</span><h3>Leave a list</h3><p>See every list you belong to and manage your membership.</p><span class="arrow-link">See my memberships →</span></button>
  </div>
  <div class="section-title"><div><h2>Lists I own</h2><p>All of the lists you look after.</p></div></div>
  <div class="surface">${state.owned.length ? state.owned.map((g) => `<button class="row-link" data-id="${escapeHTML(g.id)}">${avatar(g.displayName)}<span class="row-main"><strong>${escapeHTML(g.displayName)}</strong><small>${escapeHTML(g.id)}</small></span><span class="chevron">›</span></button>`).join('') : `<div class="empty"><span class="big">✉</span><strong>No lists yet</strong><p>Create your first list and it will appear here.</p></div>`}</div>`;
  $('hero-create').onclick = $('action-create').onclick = () => navigate('create');
  $('hero-discover').onclick = $('action-discover').onclick = () => navigate('discover');
  $('action-owned').onclick = () => navigate('owned');
  $('action-joined').onclick = () => navigate('joined');
  $('view').querySelectorAll('[data-id]').forEach((button) => button.onclick = () => openDetail(button.dataset.id));
}
async function loadOwned() {
  setTitle('Lists I own');
  showLoading();
  try { await refreshOwned(); renderListIndex('owned'); }
  catch (error) { showToast(error.message, true); renderListIndex('owned'); }
}
async function loadDiscover() {
  setTitle('Join a list');
  showLoading('Finding available lists…');
  try {
    state.discover = await api('/api/lists?scope=discover&q=' + encodeURIComponent(state.discoverQuery));
    renderListIndex('discover');
  } catch (error) { showToast(error.message, true); renderListIndex('discover'); }
}
async function loadJoined() {
  setTitle('Leave a list');
  showLoading('Finding your memberships…');
  try { await refreshJoined(); renderListIndex('joined'); }
  catch (error) { showToast(error.message, true); renderListIndex('joined'); }
}
function policyLabel(policy) {
  return ({open:'Open to join',approval:'Owner approval',closed:'Owner adds people'})[policy] || policy;
}
function senderLabel(policy) {
  return ({internal:'People in your organization',anyone:'Anyone, including external senders',specific:'Only selected people'})[policy] || policy;
}
function renderListIndex(scope) {
  const owned = scope === 'owned';
  const leaving = scope === 'joined';
  const title = owned ? 'Lists I own' : leaving ? 'Leave a list' : 'Join a list';
  const source = owned ? state.owned : leaving ? state.joined : state.discover;
  const query = owned ? state.ownedQuery : leaving ? state.joinedQuery : state.discoverQuery;
  const groups = scope === 'discover' ? source : source.filter((g) => (g.displayName + g.id).toLowerCase().includes(query.toLowerCase()));
  setTitle(title);
  $('view').innerHTML = `<div class="page-head"><div><p class="eyebrow">${owned ? 'LIST MANAGEMENT' : leaving ? 'YOUR MEMBERSHIPS' : 'LIST DIRECTORY'}</p>
    <h1>${owned ? 'Lists I own' : leaving ? 'Lists I belong to' : 'Find a list to join'}</h1>
    <p class="page-intro">${owned ? 'Every distribution list you own appears here automatically. Open one to manage members, add owners, and update settings.' : leaving ? 'Every distribution list you are a member of appears here, including lists you own. Open a list to leave it when self-service departure is allowed.' : 'Browse lists you are not yet a member of. Some lists need owner approval before you can join.'}</p></div>
    ${owned ? '<button class="btn btn-primary" id="new-list">＋ New list</button>' : ''}
  </div>
  <label class="search-bar" for="list-search"><span aria-hidden="true">⌕</span><input id="list-search" type="search" autocomplete="off" placeholder="${owned ? 'Search lists you own' : leaving ? 'Search your memberships' : 'Search names or addresses'}" value="${escapeHTML(query)}"><span class="muted" style="font-size:11px">${groups.length} shown</span></label>
  ${groups.length ? `<div class="list-grid">${groups.map((g) => `<article class="list-card"><div class="list-card-top">${avatar(g.displayName)}<div class="list-card-main"><h3>${escapeHTML(g.displayName)}</h3><div class="email">${escapeHTML(g.id)}</div></div></div>
  <div class="tags">${leaving ? `<span class="tag ${g.departOpen && !g.synced ? 'green' : 'pink'}">${g.departOpen && !g.synced ? 'You can leave' : 'Ask an owner to remove you'}</span>` : `<span class="tag ${g.joinPolicy === 'open' ? 'green' : g.joinPolicy === 'approval' ? 'violet' : 'pink'}">${escapeHTML(policyLabel(g.joinPolicy))}</span>`}<span class="tag">${g.visible ? 'In address book' : 'Hidden from address book'}</span>${g.synced ? '<span class="tag pink">Managed elsewhere</span>' : ''}</div>
  <button class="btn btn-outline btn-small" data-id="${escapeHTML(g.id)}">${owned && !g.synced ? 'Manage list' : leaving ? 'View membership' : 'View list'} <span aria-hidden="true">→</span></button></article>`).join('')}</div>` : `<div class="empty"><span class="big">⌕</span><strong>${query ? 'No matching lists' : owned ? 'No lists owned yet' : leaving ? 'You are not in any lists yet' : 'No lists available to join'}</strong><p>${query ? 'Try a different name or address.' : owned ? 'Create one to get started.' : leaving ? 'Join a list and it will appear here.' : 'Try searching for a specific list.'}</p></div>`}`;
  if (owned) $('new-list').onclick = () => navigate('create');
  const search = $('list-search');
  search.oninput = () => {
    if (scope !== 'discover') {
      if (owned) state.ownedQuery = search.value;
      else state.joinedQuery = search.value;
      const pos = search.selectionStart;
      renderListIndex(scope);
      $('list-search').focus();
      $('list-search').setSelectionRange(pos, pos);
    } else {
      state.discoverQuery = search.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        try {
          state.discover = await api('/api/lists?scope=discover&q=' + encodeURIComponent(state.discoverQuery));
          if (state.view !== 'discover') return;
          renderListIndex('discover');
          $('list-search').focus();
        } catch (error) { showToast(error.message, true); }
      }, 320);
    }
  };
  $('view').querySelectorAll('[data-id]').forEach((button) => button.onclick = () => openDetail(button.dataset.id));
}
async function openDetail(id, tab = 'overview') {
  state.detailOrigin = ['owned', 'discover', 'joined'].includes(state.view) ? state.view : 'owned';
  state.view = 'detail';
  state.detailTab = tab;
  renderNav();
  showLoading('Opening list…');
  try {
    state.selected = await api(listPath(id));
    renderNav();
    renderDetail();
  } catch (error) {
    showToast(error.message, true);
    navigate(state.detailOrigin);
  }
}
function renderDetail() {
  const g = state.selected;
  if (!g) return;
  setTitle(g.displayName);
  const owner = g.isOwner ?? g.canManage;
  const manageable = g.canManage;
  const joined = g.isMember;
  const fromLeave = state.detailOrigin === 'joined';
  const action = fromLeave ? (joined && g.departOpen && !g.synced ? '<button class="btn btn-danger" id="self-membership">Leave list</button>' : '<span class="tag pink">Ask an owner to remove you</span>') :
    owner ? (g.synced ? '<span class="tag pink">Managed elsewhere</span>' : '') :
    g.joinPending ? '<span class="tag violet">Join request pending</span>' :
    g.synced ? '' : joined ? '<span class="tag green">Already a member</span>' :
    g.joinPolicy === 'open' ? '<button class="btn btn-primary" id="self-membership">Join list</button>' :
    g.joinPolicy === 'approval' ? '<button class="btn btn-primary" id="self-membership">Request to join</button>' : '';
  let tabContent = '';
  if (state.detailTab === 'overview') {
    tabContent = `<div class="surface"><h3>At a glance</h3><div class="info-grid">
      <div class="info-item"><small>Who can send</small><strong>${escapeHTML(senderLabel(g.senderPolicy))}</strong></div>
      <div class="info-item"><small>Joining</small><strong>${escapeHTML(policyLabel(g.joinPolicy))}</strong></div>
      <div class="info-item"><small>Address book</small><strong>${g.visible ? 'Visible in Outlook' : 'Hidden from the address book'}</strong></div>
      <div class="info-item"><small>Members</small><strong>${g.memberCount == null ? 'View in Exchange' : g.memberCount}</strong></div>
      <div class="info-item"><small>Your membership</small><strong>${joined ? 'You are a member' : 'You are not a member'}</strong></div>
      <div class="info-item"><small>Owners</small><strong>${escapeHTML((g.owners || []).join(', ') || 'Not shown')}</strong></div>
    </div>${!owner && g.joinPolicy === 'closed' && !joined ? '<div class="tip">An owner adds people to this list. Contact an owner if you need access.</div>' : ''}${joined && (!g.departOpen || g.synced) ? '<div class="tip">Ask an owner to remove you from this list.</div>' : ''}</div>`;
  } else if (state.detailTab === 'members' && manageable) {
    tabContent = `<div class="surface"><h3>Members <span class="tag">${(g.members || []).length}</span></h3>
      <div class="inline-form"><input class="input" id="member-email" type="email" placeholder="Search a name or enter an email address" autocomplete="off"><button class="btn btn-violet" id="add-member">Add person</button></div>
      <div id="member-suggestions"></div>
      <div id="member-rows">${(g.members || []).length ? g.members.map((m) => `<div class="member-row">${avatar(m.name || m.email)}<div class="row-grow"><strong>${escapeHTML(m.name || m.email)}</strong><small>${escapeHTML(m.email)}</small></div><button class="btn btn-danger btn-small" data-remove="${escapeHTML(m.email)}" aria-label="Remove ${escapeHTML(m.name || m.email)}">Remove</button></div>`).join('') : '<div class="empty">No members yet. Add someone above.</div>'}</div>
      <button class="btn btn-outline btn-small" id="export-members" style="margin-top:15px">↓ Export members CSV</button>
    </div>`;
  } else if (state.detailTab === 'owners' && manageable) {
    tabContent = `<div class="surface"><h3>List owners <span class="tag">${(g.owners || []).length}</span></h3>
      <p class="muted">Owners can manage members, settings, and join requests. Add another person whenever this list needs shared ownership.</p>
      <div class="inline-form"><input class="input" id="owner-email" type="email" placeholder="Search a name or enter an email address" autocomplete="off" aria-label="New owner email address"><button class="btn btn-primary" id="add-owner">Add owner</button></div>
      <div id="owner-suggestions"></div>
      <div class="owner-rows">${(g.owners || []).map((email) => `<div class="member-row">${avatar(email)}<div class="row-grow"><strong>${escapeHTML(email)}</strong><small>List owner</small></div></div>`).join('')}</div>
    </div>`;
  } else if (state.detailTab === 'settings' && manageable) {
    tabContent = `<div class="surface"><h3>List settings</h3><form id="settings-form">
      <div class="field"><label for="settings-name">Display name</label><input class="input" id="settings-name" maxlength="80" value="${escapeHTML(g.displayName)}"></div>
      <div class="field"><label for="settings-send">Who can send</label><select class="select" id="settings-send"><option value="internal">People in your organization</option><option value="anyone">Anyone, including external senders</option><option value="specific">Only selected people</option></select></div>
      <div class="field" id="settings-senders-wrap"><label for="settings-senders">Allowed senders</label><input class="input" id="settings-senders" value="${escapeHTML((g.senders || []).join(', '))}" placeholder="name@slalom.com, another@slalom.com"><small>Enter one or more directory email addresses, separated by commas.</small></div>
      <div class="field"><label for="settings-join">How people join</label><select class="select" id="settings-join"><option value="approval">An owner approves requests</option><option value="open">Anyone can join</option><option value="closed">Owners add people</option></select></div>
      <div class="field"><label class="field-label">Address book</label><button class="toggle-row ${g.visible ? 'on' : ''}" id="settings-visible" type="button" aria-pressed="${g.visible}"><span><strong>Show in the address book</strong><small>People can find this list in Outlook.</small></span><span class="switch"></span></button></div>
      <button class="btn btn-primary" type="submit">Save changes</button>
    </form></div>`;
  }
  $('view').innerHTML = `<button class="back-link" id="detail-back">← Back to ${state.detailOrigin === 'joined' ? 'Leave a list' : state.detailOrigin === 'discover' ? 'Join a list' : 'Lists I own'}</button>
    <div class="detail-head"><div class="detail-title">${avatar(g.displayName)}<div><p class="eyebrow" style="margin-bottom:6px">${owner ? 'A LIST YOU OWN' : 'DISTRIBUTION LIST'}</p><h1>${escapeHTML(g.displayName)}</h1><p>${escapeHTML(g.id)}</p></div></div><div>${action}</div></div>
    <div class="tabs"><button data-tab="overview" class="${state.detailTab === 'overview' ? 'active' : ''}">Overview</button>
    ${manageable ? `<button data-tab="members" class="${state.detailTab === 'members' ? 'active' : ''}">Members</button><button data-tab="owners" class="${state.detailTab === 'owners' ? 'active' : ''}">Owners</button><button data-tab="settings" class="${state.detailTab === 'settings' ? 'active' : ''}">Settings</button>` : ''}</div>
    ${tabContent}`;
  $('detail-back').onclick = () => navigate(state.detailOrigin);
  $('view').querySelectorAll('[data-tab]').forEach((button) => button.onclick = () => { state.detailTab = button.dataset.tab; renderDetail(); });
  if ($('self-membership')) $('self-membership').onclick = () => changeMembership(g);
  if (state.detailTab === 'members' && manageable) bindMembers(g);
  if (state.detailTab === 'owners' && manageable) bindOwners(g);
  if (state.detailTab === 'settings' && manageable) bindSettings(g);
}
async function changeMembership(g) {
  const action = g.isMember ? 'leave' : 'join';
  const label = action === 'leave' ? 'Leave list' : g.joinPolicy === 'approval' ? 'Request to join' : 'Join list';
  modal(label, action === 'leave' ? 'You will stop receiving messages from this list.' : g.joinPolicy === 'approval' ? 'An owner will review your request in DL Studio.' : 'You will be added to this list.',
    label, async () => {
      try {
        const result = await api(listPath(g.id) + '/membership', 'POST', {action});
        showToast(result.requested ? 'Request sent to the list owner.' : action === 'leave' ? 'You left the list.' : 'You joined the list.');
        if (result.requested) {
          state.selected = await api(listPath(g.id));
          renderDetail();
        } else {
          await navigate('joined');
        }
      } catch (error) { showToast(error.message, true); }
    }, action === 'leave');
}
function bindMembers(g) {
  const input = $('member-email');
  attachDirectorySearch(input, $('member-suggestions'), (person) => { input.value = person.email; });
  $('add-member').onclick = async () => {
    const email = input.value.trim();
    if (!validEmail(email)) return showToast('Enter a valid email address.', true);
    try {
      await api(listPath(g.id) + '/members', 'POST', {email});
      showToast('Member added.');
      state.selected = await api(listPath(g.id));
      state.detailTab = 'members';
      renderDetail();
    } catch (error) { showToast(error.message, true); }
  };
  $('view').querySelectorAll('[data-remove]').forEach((button) => button.onclick = () => {
    const email = button.dataset.remove;
    modal('Remove member', 'Remove ' + email + ' from this list?', 'Remove', async () => {
      try {
        await api(listPath(g.id) + '/members/' + encodeURIComponent(email), 'DELETE', {});
        showToast('Member removed.');
        state.selected = await api(listPath(g.id));
        state.detailTab = 'members';
        renderDetail();
      } catch (error) { showToast(error.message, true); }
    }, true);
  });
  $('export-members').onclick = () => {
    const rows = ['Name,Email'].concat((g.members || []).map((m) => [m.name, m.email].map(csvCell).join(',')));
    downloadFile(g.alias + '-members.csv', rows.join('\r\n') + '\r\n', 'text/csv');
  };
}
function bindOwners(g) {
  const input = $('owner-email');
  attachDirectorySearch(input, $('owner-suggestions'), (person) => { input.value = person.email; });
  $('add-owner').onclick = async () => {
    const email = input.value.trim().toLowerCase();
    if (!validEmail(email)) return showToast('Enter a valid owner address.', true);
    try {
      await api(listPath(g.id) + '/owners', 'POST', {email});
      showToast('Owner added.');
      state.selected = await api(listPath(g.id));
      state.detailTab = 'owners';
      renderDetail();
    } catch (error) { showToast(error.message, true); }
  };
}
function bindSettings(g) {
  $('settings-send').value = g.senderPolicy;
  $('settings-join').value = g.joinPolicy;
  let visible = g.visible;
  const updateSenders = () => $('settings-senders-wrap').style.display = $('settings-send').value === 'specific' ? '' : 'none';
  updateSenders();
  $('settings-send').onchange = updateSenders;
  $('settings-visible').onclick = () => {
    visible = !visible;
    $('settings-visible').classList.toggle('on', visible);
    $('settings-visible').setAttribute('aria-pressed', String(visible));
  };
  $('settings-form').onsubmit = async (event) => {
    event.preventDefault();
    const senderPolicy = $('settings-send').value;
    const senders = senderPolicy === 'specific' ? parseEmails($('settings-senders').value) : [];
    if (senderPolicy === 'specific' && !senders.length) return showToast('Add at least one allowed sender.', true);
    const payload = {displayName:$('settings-name').value.trim(), senderPolicy, senders,
      visible, joinPolicy:$('settings-join').value};
    try {
      await api(listPath(g.id), 'PATCH', payload);
      showToast('List settings saved.');
      state.selected = await api(listPath(g.id));
      state.detailTab = 'settings';
      renderDetail();
    } catch (error) { showToast(error.message, true); }
  };
}
function attachDirectorySearch(input, results, onPick) {
  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      try {
        const people = await api('/api/directory?q=' + encodeURIComponent(q));
        if (input.value.trim() !== q) return;
        results.innerHTML = people.length ? `<div class="suggestions">${people.map((p) => `<button type="button" data-email="${escapeHTML(p.email)}">${avatar(p.name)}<span><strong>${escapeHTML(p.name)}</strong><small>${escapeHTML(p.email)}</small></span></button>`).join('')}</div>` : '';
        results.querySelectorAll('[data-email]').forEach((button) => button.onclick = () => {
          const person = people.find((p) => p.email === button.dataset.email);
          onPick(person);
          results.innerHTML = '';
        });
      } catch { results.innerHTML = ''; }
    }, 260);
  };
}
function freshWizard() {
  return {step:0, displayName:'', alias:'', aliasTouched:false, aliasAvailable:false,
    senderPolicy:'internal', senders:[], visible:true, joinPolicy:'approval', coOwner:null,
    members:[], peopleTab:'search', paste:'', csvErrors:[]};
}
const stepLabels = ['Name it','Set the rules','Add people','Review'];
function renderWizard() {
  const w = state.wizard;
  setTitle('Create a list');
  const title = ['Give your list a name','Set the rules','Add your people','Review and create'][w.step];
  const subtitle = [
    'Choose a name people will recognize and an email address that is easy to share.',
    'A few plain-language choices decide who can send and how people join.',
    'Search the directory, paste addresses, or upload a CSV. You can add more people later.',
    'Make sure everything looks right before creating your list.'
  ][w.step];
  $('view').innerHTML = `<div class="page-head"><div><p class="eyebrow">CREATE A DISTRIBUTION LIST</p><h1>Make something great together.</h1><p class="page-intro">A few quick steps and your list will be ready to use.</p></div></div>
    <div class="wizard-progress" aria-label="Creation progress">${stepLabels.map((label, i) => `<div class="step ${i === w.step ? 'current' : i < w.step ? 'done' : ''}"><span>${i < w.step ? '✓' : i + 1}</span>${label}</div>${i < 3 ? '<div class="connector"></div>' : ''}`).join('')}</div>
    <div class="wizard-layout"><section class="wizard-card"><h2>${title}</h2><p class="muted">${subtitle}</p><div id="wizard-fields"></div>
      <div class="wizard-footer"><button class="btn btn-outline" id="wizard-back">${w.step === 0 ? 'Cancel' : '← Back'}</button><button class="btn btn-primary" id="wizard-next">${w.step === 3 ? 'Create list' : 'Continue →'}</button></div>
    </section><aside class="wizard-side"><span class="spark">✦</span><h3>${['A name that travels','Safe defaults, clear choices','A clean starting point','Ready when you are'][w.step]}</h3><p>${[
      'Start with a market, team, or project. We’ll turn the name into an address and check that it is available.',
      'Your list starts with internal senders, address book visibility, and owner approval for joining. Change any of these if your list needs something else.',
      'You can start with no members, add people one at a time, or bring a CSV. We validate addresses before saving.',
      'Owners can update members, owners, and settings later from Lists I own. New address book entries may take time to appear in Outlook.'
    ][w.step]}</p></aside></div>`;
  $('wizard-back').onclick = () => { if (w.step === 0) navigate('home'); else { w.step--; renderWizard(); } };
  $('wizard-next').onclick = () => {
    if (w.step === 0) {
      if (w.displayName.trim().length < 3 || !w.aliasAvailable) return showToast('Choose an available name and address.', true);
      w.step++; renderWizard();
    } else if (w.step === 1) {
      if (w.senderPolicy === 'specific' && (!w.senders.length || !w.senders.every(validEmail))) return showToast('Add valid allowed sender addresses.', true);
      if (w.coOwner && !validEmail(w.coOwner)) return showToast('Choose a valid co-owner address.', true);
      w.step++; renderWizard();
    } else if (w.step === 2) { w.step++; renderWizard(); }
    else createList();
  };
  if (w.step === 0) renderWizardName();
  if (w.step === 1) renderWizardRules();
  if (w.step === 2) renderWizardPeople();
  if (w.step === 3) renderWizardReview();
}
function renderWizardName() {
  const w = state.wizard;
  $('wizard-fields').innerHTML = `<div class="field"><label for="list-name">Display name</label><input class="input" id="list-name" maxlength="80" placeholder="e.g. Chicago Holiday Party 2026" value="${escapeHTML(w.displayName)}" autofocus><small>This is what people see in Outlook.</small></div>
    <div class="field"><label for="list-alias">Email address</label><div class="input-row"><input class="input" id="list-alias" maxlength="40" placeholder="your-list-name" value="${escapeHTML(w.alias)}"><span class="input-suffix">@${escapeHTML(state.config.mailDomain)}</span></div><div class="field-status" id="alias-status" role="status"></div></div>
    <div class="preview-box"><small>OUTLOOK PREVIEW</small>To: <span class="preview-pill" id="name-preview">${escapeHTML(w.displayName || 'Your list name')}</span></div>
    <div class="tip"><strong>Naming tip:</strong> A market, office, or team name helps people find the right list.</div>`;
  const name = $('list-name'), alias = $('list-alias');
  const update = () => {
    w.displayName = name.value;
    $('name-preview').textContent = w.displayName || 'Your list name';
    if (!w.aliasTouched) { w.alias = slug(w.displayName); alias.value = w.alias; }
    checkAlias();
  };
  name.oninput = update;
  alias.oninput = () => {
    w.aliasTouched = true;
    w.alias = alias.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    alias.value = w.alias;
    checkAlias();
  };
  checkAlias();
}
function checkAlias() {
  const w = state.wizard;
  const status = $('alias-status');
  const next = $('wizard-next');
  if (!status || !next) return;
  clearTimeout(aliasTimer);
  w.aliasAvailable = false;
  next.disabled = true;
  if (w.displayName.trim().length < 3) { status.textContent = 'Use a display name with at least 3 characters.'; status.className = 'field-status'; return; }
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(w.alias)) {
    status.textContent = 'Use 3 to 40 lowercase letters, numbers, or dashes.';
    status.className = 'field-status error'; return;
  }
  status.textContent = 'Checking address…';
  status.className = 'field-status';
  const value = w.alias;
  aliasTimer = setTimeout(async () => {
    try {
      const result = await api('/api/alias?value=' + encodeURIComponent(value));
      if (value !== w.alias || state.view !== 'create' || w.step !== 0) return;
      w.aliasAvailable = result.available;
      status.textContent = result.available ? '✓ Address is available' : 'This address is already taken. Try another.';
      status.className = 'field-status ' + (result.available ? 'ok' : 'error');
      next.disabled = !result.available;
    } catch (error) { status.textContent = error.message; status.className = 'field-status error'; }
  }, 300);
}
function option(field, value, label, hint, recommended = false) {
  const w = state.wizard;
  return `<button type="button" class="option ${w[field] === value ? 'selected' : ''}" data-field="${field}" data-value="${value}" aria-pressed="${w[field] === value}">
    <span class="option-dot"></span><span><strong>${label}${recommended ? '<span class="rec">RECOMMENDED</span>' : ''}</strong><small>${hint}</small></span></button>`;
}
function renderWizardRules() {
  const w = state.wizard;
  $('wizard-fields').innerHTML = `<div class="field"><span class="field-label">Who can send to this list?</span><div class="option-list">
    ${option('senderPolicy','internal','People in your organization','Helps keep outside spam away.',true)}
    ${option('senderPolicy','anyone','Anyone','Allows messages from outside your organization.')}
    ${option('senderPolicy','specific','Only selected people','You choose which senders are allowed.')}
  </div></div>
  ${w.senderPolicy === 'specific' ? `<div class="field"><label for="allowed-senders">Allowed senders</label><input class="input" id="allowed-senders" value="${escapeHTML(w.senders.join(', '))}" placeholder="person@${escapeHTML(state.config.mailDomain)}"><small>Separate email addresses with commas.</small></div>` : ''}
  <div class="field"><span class="field-label">Address book</span><button type="button" class="toggle-row ${w.visible ? 'on' : ''}" id="wizard-visible" aria-pressed="${w.visible}"><span><strong>Show in the address book</strong><small>People can find this list in Outlook.</small></span><span class="switch"></span></button></div>
  <div class="field"><span class="field-label">How do people join?</span><div class="option-list">
    ${option('joinPolicy','approval','An owner approves requests','People ask to join; an owner decides.',true)}
    ${option('joinPolicy','open','Anyone can join','People can add themselves immediately.')}
    ${option('joinPolicy','closed','Owners add people','No self-service join requests.')}
  </div></div>
  <div class="field"><label for="co-owner">Co-owner <span style="color:var(--muted);font-weight:500;text-transform:none">(optional)</span></label><input class="input" id="co-owner" type="email" autocomplete="off" placeholder="Search for a person" value="${escapeHTML(w.coOwner || '')}"><div id="co-owner-results"></div><small>A second owner can keep the list up to date when you are away.</small></div>`;
  $('wizard-fields').querySelectorAll('.option').forEach((button) => button.onclick = () => {
    w[button.dataset.field] = button.dataset.value;
    if (button.dataset.field === 'senderPolicy' && w.senderPolicy !== 'specific') w.senders = [];
    renderWizard();
  });
  $('wizard-visible').onclick = () => { w.visible = !w.visible; $('wizard-visible').classList.toggle('on', w.visible); $('wizard-visible').setAttribute('aria-pressed', String(w.visible)); };
  if ($('allowed-senders')) $('allowed-senders').oninput = () => { w.senders = parseEmails($('allowed-senders').value); };
  $('co-owner').addEventListener('input', () => { w.coOwner = $('co-owner').value.trim() || null; });
  attachDirectorySearch($('co-owner'), $('co-owner-results'), (person) => { w.coOwner = person.email; $('co-owner').value = person.email; });
}
function parseEmails(text) {
  return [...new Set(String(text).split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
}
function renderWizardPeople() {
  const w = state.wizard;
  $('wizard-fields').innerHTML = `<div class="segment"><button data-people="search" class="${w.peopleTab === 'search' ? 'active' : ''}">Search</button><button data-people="paste" class="${w.peopleTab === 'paste' ? 'active' : ''}">Paste</button><button data-people="csv" class="${w.peopleTab === 'csv' ? 'active' : ''}">CSV file</button></div>
    <div id="people-pane"></div><div class="field-label" style="margin-top:21px">Members to add · ${w.members.length}</div>
    <div class="chip-list">${w.members.length ? w.members.map((m) => `<span class="chip">${avatar(m.name || m.email)}${escapeHTML(m.name || m.email)}<button type="button" data-remove-member="${escapeHTML(m.email)}" aria-label="Remove ${escapeHTML(m.email)}">×</button></span>`).join('') : '<p class="muted" style="font-size:12px">No one added yet. You can add people after creating the list.</p>'}</div>
    ${w.csvErrors.length ? `<div class="tip">${w.csvErrors.length} address(es) skipped: ${escapeHTML(w.csvErrors.slice(0,5).join(', '))}</div>` : ''}`;
  $('wizard-fields').querySelectorAll('[data-people]').forEach((button) => button.onclick = () => { w.peopleTab = button.dataset.people; renderWizard(); });
  $('wizard-fields').querySelectorAll('[data-remove-member]').forEach((button) => button.onclick = () => { w.members = w.members.filter((m) => m.email !== button.dataset.removeMember); renderWizard(); });
  const pane = $('people-pane');
  if (w.peopleTab === 'search') {
    pane.innerHTML = '<label class="field-label" for="person-search">Find people in your directory</label><input class="input" id="person-search" autocomplete="off" placeholder="Type a name or email address"><div id="person-results"></div>';
    attachDirectorySearch($('person-search'), $('person-results'), (person) => {
      if (!w.members.some((m) => m.email === person.email)) w.members.push(person);
      renderWizard();
    });
  } else if (w.peopleTab === 'paste') {
    pane.innerHTML = `<label class="field-label" for="paste-emails">Paste email addresses</label><textarea class="textarea" id="paste-emails" placeholder="one.person@${escapeHTML(state.config.mailDomain)}, another.person@${escapeHTML(state.config.mailDomain)}">${escapeHTML(w.paste)}</textarea><p class="field-hint">Use commas, semicolons, spaces, or new lines.</p><button class="btn btn-violet btn-small" id="paste-add">Add these people</button>`;
    $('paste-emails').oninput = () => w.paste = $('paste-emails').value;
    $('paste-add').onclick = () => {
      let added = 0;
      for (const email of parseEmails(w.paste)) {
        if (validEmail(email) && !w.members.some((m) => m.email === email)) { w.members.push({email, name:email}); added++; }
        else if (!validEmail(email)) w.csvErrors.push(email);
      }
      w.paste = '';
      renderWizard();
      showToast(added + ' address(es) added. The tenant directory is checked when you create the list.');
    };
  } else {
    pane.innerHTML = `<label class="field-label" for="csv-file">Upload a CSV</label><div class="empty"><span class="big">⇪</span><strong>Choose a member file</strong><p>Use an Email column with one address per row.</p><input type="file" id="csv-file" accept=".csv,text/csv" class="input" style="max-width:300px"><br><button class="btn btn-outline btn-small" id="csv-template" style="margin-top:12px">↓ Download template</button></div>`;
    $('csv-template').onclick = () => downloadFile('dl-studio-members.csv', 'Email\r\nperson@slalom.com\r\n', 'text/csv');
    $('csv-file').onchange = async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 1024 * 1024) return showToast('Choose a CSV smaller than 1 MB.', true);
      try {
        const rows = parseCSV(await file.text());
        const header = rows.shift().map((x) => x.trim().toLowerCase());
        const column = header.indexOf('email');
        if (column < 0) return showToast('CSV needs an Email column.', true);
        let added = 0;
        w.csvErrors = [];
        for (const row of rows) {
          const email = (row[column] || '').trim().toLowerCase();
          if (!email) continue;
          if (validEmail(email) && !w.members.some((m) => m.email === email)) { w.members.push({email, name:email}); added++; }
          else if (!validEmail(email)) w.csvErrors.push(email);
        }
        renderWizard();
        showToast(added + ' address(es) added from the file.');
      } catch (error) { showToast(error.message, true); }
    };
  }
}
function parseCSV(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && quoted && text[i+1] === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i+1] === '\n') i++;
      row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
      row = []; cell = '';
    } else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
  if (quoted) throw new Error('CSV has an unmatched quote.');
  return rows;
}
function csvCell(value) { return '"' + String(value ?? '').replace(/"/g, '""') + '"'; }
function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderWizardReview() {
  const w = state.wizard;
  const summaryRow = (label, value, step) => `<div class="summary-row"><div><small>${label}</small><strong>${escapeHTML(value)}</strong></div><button type="button" data-edit="${step}">Edit</button></div>`;
  $('wizard-fields').innerHTML = `<div class="summary">
    ${summaryRow('List name',w.displayName,0)}${summaryRow('Email address',w.alias + '@' + state.config.mailDomain,0)}
    ${summaryRow('Who can send',senderLabel(w.senderPolicy),1)}${summaryRow('Address book',w.visible ? 'Visible in Outlook' : 'Hidden',1)}
    ${summaryRow('Joining',policyLabel(w.joinPolicy),1)}${summaryRow('Owners','You' + (w.coOwner ? ' + ' + w.coOwner : ''),1)}
    ${summaryRow('Starting members',w.members.length + (w.members.length === 1 ? ' person' : ' people'),2)}</div>
    ${!w.coOwner ? '<div class="review-warning">Tip: Adding a co-owner makes it easier to keep this list up to date.</div>' : ''}
    <div class="tip blue"><strong>Good to know:</strong> Your list address can be used after creation. It may take time to appear in the Outlook address book.</div>`;
  $('wizard-fields').querySelectorAll('[data-edit]').forEach((button) => button.onclick = () => { w.step = Number(button.dataset.edit); renderWizard(); });
}
async function createList() {
  const w = state.wizard;
  const next = $('wizard-next');
  next.disabled = true;
  next.textContent = 'Creating…';
  try {
    const result = await api('/api/lists', 'POST', {
      displayName:w.displayName.trim(), alias:w.alias, senderPolicy:w.senderPolicy,
      senders:w.senders, visible:w.visible, joinPolicy:w.joinPolicy,
      coOwner:w.coOwner || null, members:w.members.map((m) => m.email)
    });
    state.created = result;
    await refreshOwned();
    renderSuccess();
  } catch (error) {
    showToast(error.message, true);
    next.disabled = false;
    next.textContent = 'Create list';
  }
}
function renderSuccess() {
  const g = state.created;
  setTitle('List created');
  $('view').innerHTML = `<div class="success"><div class="success-icon">✓</div><p class="eyebrow">YOUR LIST IS READY</p><h1>${escapeHTML(g.displayName)}</h1>
    <p class="muted">Your new distribution list has been created.</p><div class="preview-box"><small>LIST ADDRESS</small><strong>${escapeHTML(g.id)}</strong></div>
    <div class="tip blue"><strong>Heads up:</strong> It may take time to appear in the Outlook address book. You can use the address directly in the meantime.</div>
    ${(g.warnings || []).length ? `<div class="review-warning">${escapeHTML(g.warnings.join(' '))}</div>` : ''}
    <button class="btn btn-primary" id="manage-created">Manage this list →</button><button class="btn btn-outline" id="back-home" style="margin:15px 0 0 8px">Back to home</button>
  </div>`;
  $('manage-created').onclick = () => openDetail(g.id);
  $('back-home').onclick = () => navigate('home');
}
async function loadRequests() {
  setTitle('Requests');
  showLoading('Loading join requests…');
  try { await refreshRequests(); renderRequests(); }
  catch (error) { showToast(error.message, true); renderRequests(); }
}
function renderRequests() {
  setTitle('Requests');
  $('view').innerHTML = `<div class="page-head"><div><p class="eyebrow">OWNER INBOX</p><h1>Join requests</h1><p class="page-intro">Approve or decline requests for lists you own. Approval adds the person to the list.</p></div></div>
  <div class="surface">${state.requests.length ? state.requests.map((r) => `<div class="request-row">${avatar(r.requester_name)}<div class="row-grow"><strong>${escapeHTML(r.requester_name)}</strong><small>${escapeHTML(r.requester_email)} wants to join ${escapeHTML(r.list_id)} · ${formatDate(r.created_at)}</small></div><button class="btn btn-outline btn-small" data-decline="${r.id}">Decline</button><button class="btn btn-violet btn-small" data-approve="${r.id}">Approve</button></div>`).join('') : '<div class="empty"><span class="big">✓</span><strong>All caught up</strong><p>New requests for lists you own will appear here.</p></div>'}</div>`;
  $('view').querySelectorAll('[data-approve]').forEach((button) => button.onclick = () => decideRequest(Number(button.dataset.approve), 'approved'));
  $('view').querySelectorAll('[data-decline]').forEach((button) => button.onclick = () => decideRequest(Number(button.dataset.decline), 'declined'));
}
async function decideRequest(id, decision) {
  try {
    await api('/api/requests/' + id, 'POST', {decision});
    showToast(decision === 'approved' ? 'Request approved. Member added.' : 'Request declined.');
    await refreshRequests();
    renderRequests();
  } catch (error) { showToast(error.message, true); }
}
async function loadActivity() {
  setTitle('Activity');
  showLoading('Loading activity…');
  try { state.activity = await api('/api/activity'); renderActivity(); }
  catch (error) { showToast(error.message, true); renderActivity(); }
}
function renderActivity() {
  setTitle('Activity');
  $('view').innerHTML = `<div class="page-head"><div><p class="eyebrow">YOUR AUDIT TRAIL</p><h1>Recent activity</h1>
    <p class="page-intro">Only actions you took in DL Studio appear here.</p></div></div>
    <div class="surface">${state.activity.length ? state.activity.map((a) => `<div class="activity-row"><span class="activity-dot"></span><div class="row-grow"><strong>${escapeHTML(a.action)} · ${escapeHTML(a.list_id)}</strong><small>${escapeHTML(a.actor_name)} · ${escapeHTML(a.detail)}</small></div><time>${formatDate(a.created_at)}</time></div>`).join('') : '<div class="empty"><span class="big">◌</span><strong>Nothing to show yet</strong><p>Your list changes will appear here.</p></div>'}</div>`;
}
init();
