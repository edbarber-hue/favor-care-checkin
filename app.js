import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, collection, onSnapshot, query, orderBy, limit,
  addDoc, setDoc, updateDoc, deleteDoc, getDoc, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ---------- helpers ----------
function h(tag, props, ...kids){
  const el = document.createElement(tag);
  if (props) for (const k in props){
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}
function add(el, c){
  if (c == null || c === false) return;
  if (Array.isArray(c)) { c.forEach(x => add(el, x)); return; }
  el.append(c.nodeType ? c : document.createTextNode(String(c)));
}
const $ = id => document.getElementById(id);
const pad = n => n < 10 ? '0' + n : '' + n;
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
const parseYmd = s => { const p = String(s).split('-'); return new Date(+p[0], +p[1]-1, +p[2]); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const fmt = (d, wd) => d.toLocaleDateString('en-US', wd ? {weekday:'short', month:'short', day:'numeric'} : {month:'short', day:'numeric'});
const initials = n => String(n||'?').replace(/\(.*?\)/g,'').split(/\s+/).filter(Boolean).slice(0,2).map(w => w[0]).join('').toUpperCase();
const lsGet = k => { try { return localStorage.getItem(k); } catch(e){ return null; } };
const lsSet = (k,v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k,v); } catch(e){} };
const today = () => parseYmd(ymd(new Date()));
const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\(.*?\)/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || ('p-' + Date.now());

// ---------- care status ----------
// Green: checked on within 4 weeks. Yellow: 5–6 weeks. Red: 7+ weeks or never.
const GREEN_DAYS = 28, YELLOW_DAYS = 42;
const LEVEL = {
  green: { label:'Fit', dot:'var(--g)', bg:'var(--g-l)', fg:'var(--g-t)' },
  yellow:{ label:'Check soon', dot:'var(--y)', bg:'var(--y-l)', fg:'var(--y-t)' },
  red:   { label:'Overdue', dot:'var(--r)', bg:'var(--r-l)', fg:'var(--r-t)' }
};
function ago(days){
  if (days == null) return 'Never checked on';
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + ' days ago';
  const w = Math.floor(days / 7);
  return w + (w === 1 ? ' week ago' : ' weeks ago');
}
function healthLevel(pct){
  if (pct >= 80) return { name:'Thriving', bg:'var(--g-l)', fg:'var(--g-t)', note:'Almost everyone has been cared for this month.' };
  if (pct >= 60) return { name:'Healthy', bg:'var(--g-l)', fg:'var(--g-t)', note:'Most people have been checked on. Keep going.' };
  if (pct >= 40) return { name:'Needs care', bg:'var(--y-l)', fg:'var(--y-t)', note:'A lot of people are waiting on a check-in.' };
  return { name:'At risk', bg:'var(--r-l)', fg:'var(--r-t)', note:'Most people haven’t been checked on in a month.' };
}

// ---------- state ----------
const S = {
  auth:null, db:null, user:null, me:null, // me = {name, dept, role, email}
  people:[], checkins:[], config:null, myNotes:[], allowlist:[],
  got:{people:false, config:false}, error:'',
  dept: lsGet('care.dept') || 'All', filter:'need', q:'',
  open:null, form:null, toastTimer:null, unsubs:[],
  admin:null // {tab, editing}
};
const isAdmin = () => !!(S.me && S.me.role === 'admin');
const depts = () => (S.config && S.config.depts) || [];
const deptMeta = name => depts().find(d => d.name === name);

function round(){
  const c = S.config || {};
  const start = parseYmd(c.roundStart || ymd(new Date()));
  const days = c.roundDays || 14;
  const t = today();
  let i = Math.floor((t - start) / 86400000 / days); if (i < 0) i = 0;
  const rs = addDays(start, i*days), re = addDays(rs, days-1);
  return { start: rs, end: re, next: addDays(re, 1), huddle: addDays(rs, c.huddleOffset != null ? c.huddleOffset : days-1) };
}
const inDept = p => S.dept === 'All' || p.dept === S.dept || p.dept2 === S.dept;
const activePeople = () => S.people.filter(p => p.active !== false);
function info(p){
  const cs = S.checkins.filter(c => c.personId === p.id);
  const last = cs[0];
  const days = last ? Math.round((today() - parseYmd(last.date)) / 86400000) : null;
  const level = days == null ? 'red' : days <= GREEN_DAYS ? 'green' : days <= YELLOW_DAYS ? 'yellow' : 'red';
  const rated = cs.filter(c => typeof c.rating === 'number');
  return { last, days, level, rating: rated.length ? rated[0].rating : null, concern: cs.find(c => c.concern && !c.resolved), all: cs };
}
const whoName = c => !c ? 'Someone' : (c.by && S.user && c.by === S.user.uid ? 'You' : (c.byName || 'Someone'));

// ---------- toast ----------
function toast(text, undo){
  const box = $('toast'); box.textContent = '';
  clearTimeout(S.toastTimer);
  box.append(h('div', { class:'toast', role:'status' }, h('span', null, text), undo ? h('button', { type:'button', onclick: () => { box.textContent = ''; undo(); } }, 'Undo') : null));
  S.toastTimer = setTimeout(() => { box.textContent = ''; }, 6000);
}

// ---------- auth screens ----------
const LG = { step:'signin', err:'', msg:'', busy:false, email: lsGet('care.email') || '' };
function authInput(id, type, label, value, auto){
  const inp = h('input', { id, type, class:'inp', autocomplete: auto || null });
  if (value) inp.value = value;
  return [h('label', { for:id, style:'font-weight:600' }, label), inp];
}
function renderLogin(){
  const box = $('login'); box.textContent = '';
  if (LG.step === 'none') return;
  const card = h('div', { class:'authcard' });
  const err = LG.err ? h('div', { class:'err', role:'alert' }, LG.err) : null;
  const msg = LG.msg ? h('div', { class:'ok', role:'status' }, LG.msg) : null;
  const linkBtn = (text, fn) => h('button', { type:'button', class:'btn ghost small', style:'color:var(--blue);padding:0', onclick: fn }, text);
  const go = step => { LG.step = step; LG.err = ''; LG.msg = ''; renderLogin(); };

  if (LG.step === 'loading'){
    card.append(h('div', { style:'font-size:18px' }, 'Loading…'));
  } else if (LG.step === 'setup'){
    card.append(h('strong', { style:'font-size:20px' }, 'Almost ready'), h('p', { style:'margin:0' }, 'This site isn’t connected to its database yet. Paste the Firebase settings into config.js (see the README).'));
  } else if (LG.step === 'signin' || LG.step === 'create'){
    const creating = LG.step === 'create';
    const [el, email] = authInput('email', 'email', 'Email', LG.email, 'email');
    const [pl, pw] = authInput('pw', 'password', creating ? 'Choose a password (6+ characters)' : 'Password', '', creating ? 'new-password' : 'current-password');
    const extra = creating ? authInput('pw2', 'password', 'Type it again', '', 'new-password') : [];
    const form = h('form', { style:'display:flex;flex-direction:column;gap:10px', onsubmit: e => {
      e.preventDefault();
      LG.email = email.value.trim(); lsSet('care.email', LG.email);
      creating ? doCreate(LG.email, pw.value, extra[1].value) : doSignIn(LG.email, pw.value);
    } },
      h('strong', { style:'font-size:22px' }, creating ? 'Create your account' : 'Sign in'),
      creating ? h('p', { class:'muted', style:'margin:0;font-size:14px' }, 'Use the email Ed added you with.') : null,
      el, email, pl, pw, extra, err, msg,
      h('button', { type:'submit', class:'btn solid', style:'min-height:52px;font-size:17px', disabled: LG.busy || null }, LG.busy ? 'One moment…' : (creating ? 'Create account' : 'Sign in')));
    card.append(form,
      h('div', { class:'row', style:'flex-wrap:wrap' },
        creating ? linkBtn('I already have an account', () => go('signin')) : linkBtn('First time? Create an account', () => go('create')),
        creating ? null : linkBtn('Forgot password?', () => go('forgot'))));
  } else if (LG.step === 'forgot'){
    const [el, email] = authInput('email', 'email', 'Email', LG.email, 'email');
    card.append(h('form', { style:'display:flex;flex-direction:column;gap:10px', onsubmit: async e => {
      e.preventDefault(); LG.email = email.value.trim(); LG.busy = true; renderLogin();
      try { await sendPasswordResetEmail(S.auth, LG.email); LG.msg = 'If that email has an account, a reset link is on its way. Check your inbox.'; LG.err = ''; }
      catch(x){ LG.err = friendly(x); }
      LG.busy = false; renderLogin();
    } }, h('strong', { style:'font-size:22px' }, 'Reset your password'), el, email, err, msg,
      h('button', { type:'submit', class:'btn solid', style:'min-height:52px', disabled: LG.busy || null }, 'Send reset link')),
      linkBtn('Back to sign in', () => go('signin')));
  } else if (LG.step === 'verify'){
    card.append(h('strong', { style:'font-size:22px' }, 'Check your email'),
      h('p', { style:'margin:0' }, 'We sent a link to ' + (S.user ? S.user.email : 'your email') + '. Tap it, then come back here and press Continue.'),
      err, msg,
      h('button', { type:'button', class:'btn solid', style:'min-height:52px', onclick: async () => {
        try { await S.user.reload(); await S.user.getIdToken(true); afterAuth(S.auth.currentUser); }
        catch(x){ LG.err = friendly(x); renderLogin(); }
      } }, 'Continue'),
      h('div', { class:'row' },
        linkBtn('Send the link again', async () => { try { await sendEmailVerification(S.user); LG.msg = 'Sent again.'; LG.err=''; } catch(x){ LG.err = friendly(x); } renderLogin(); }),
        linkBtn('Sign out', () => signOut(S.auth))));
  } else if (LG.step === 'notlisted'){
    card.append(h('strong', { style:'font-size:22px' }, 'You’re not on the list yet'),
      h('p', { style:'margin:0' }, (S.user ? S.user.email : 'This email') + ' isn’t set up as a Favor Kids leader. Ask Ed to add you, then sign in again.'),
      h('button', { type:'button', class:'btn solid', style:'min-height:52px', onclick: () => afterAuth(S.auth.currentUser) }, 'Try again'),
      linkBtn('Sign out', () => signOut(S.auth)));
  }
  box.append(h('div', { class:'login', role:'dialog', 'aria-modal':'true', 'aria-labelledby':'lgTitle' },
    h('div', { class:'in' },
      h('span', { class:'eyebrow' }, 'FAVOR KIDS LEADERS'),
      h('h1', { id:'lgTitle', style:'font-size:64px' }, 'CARE CHECK-IN'),
      card)));
  const first = box.querySelector('input'); if (first && !first.value) setTimeout(() => first.focus(), 0);
}
function friendly(e){
  const c = (e && e.code) || '';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'That email or password isn’t right.';
  if (c.includes('email-already-in-use')) return 'There’s already an account for that email. Sign in instead.';
  if (c.includes('invalid-email')) return 'That doesn’t look like an email address.';
  if (c.includes('weak-password')) return 'Use at least 6 characters.';
  if (c.includes('too-many-requests')) return 'Too many tries. Wait a few minutes and try again.';
  if (c.includes('network')) return 'Can’t reach the internet. Check your connection.';
  return 'Something went wrong. Try again.';
}
async function doSignIn(email, pw){
  LG.busy = true; LG.err = ''; renderLogin();
  try { await signInWithEmailAndPassword(S.auth, email, pw); }
  catch(e){ LG.err = friendly(e); }
  LG.busy = false; if (LG.step !== 'none') renderLogin();
}
async function doCreate(email, pw, pw2){
  if ((pw||'').length < 6){ LG.err = 'Use at least 6 characters.'; renderLogin(); return; }
  if (pw !== pw2){ LG.err = 'The two passwords don’t match.'; renderLogin(); return; }
  LG.busy = true; LG.err = ''; renderLogin();
  try {
    const cred = await createUserWithEmailAndPassword(S.auth, email, pw);
    await sendEmailVerification(cred.user);
  } catch(e){ LG.err = friendly(e); }
  LG.busy = false; renderLogin();
}

async function afterAuth(u){
  stopListeners();
  S.user = u; S.me = null;
  if (!u){ LG.step = 'signin'; renderLogin(); renderAll(); return; }
  if (!u.emailVerified){ LG.step = 'verify'; renderLogin(); return; }
  LG.step = 'loading'; renderLogin();
  try {
    const snap = await getDoc(doc(S.db, 'allowlist', u.email.toLowerCase()));
    if (!snap.exists()){ LG.step = 'notlisted'; renderLogin(); return; }
    const d = snap.data();
    S.me = { name: d.name || u.email, dept: d.dept || 'All', role: d.role || 'lead', email: u.email.toLowerCase() };
  } catch(e){ LG.step = 'notlisted'; renderLogin(); return; }
  if (!lsGet('care.dept') || lsGet('care.who') !== S.me.email){ S.dept = S.me.dept; lsSet('care.dept', S.dept); lsSet('care.who', S.me.email); }
  LG.step = 'none'; renderLogin();
  startListeners();
  renderAll();
}

// ---------- data ----------
function stopListeners(){ S.unsubs.forEach(f => { try { f(); } catch(e){} }); S.unsubs = []; S.people = []; S.checkins = []; S.myNotes = []; S.allowlist = []; S.config = null; S.got = {people:false, config:false}; }
function startListeners(){
  const onErr = () => { S.error = 'Couldn’t load the latest data. Reload to try again.'; renderAll(); };
  S.unsubs.push(onSnapshot(doc(S.db, 'config', 'main'), snap => {
    S.config = snap.exists() ? snap.data() : null; S.got.config = true;
    if (S.config && S.dept !== 'All' && !deptMeta(S.dept)) S.dept = 'All';
    renderAll(); if (S.admin) renderAdmin();
  }, onErr));
  S.unsubs.push(onSnapshot(collection(S.db, 'people'), snap => {
    S.people = snap.docs.map(d => ({ ...d.data(), id: d.id })).sort((a,b) => String(a.name).localeCompare(String(b.name)));
    S.got.people = true; renderAll(); if (S.admin) renderAdmin();
  }, onErr));
  S.unsubs.push(onSnapshot(query(collection(S.db, 'checkins'), orderBy('at', 'desc'), limit(2000)), snap => {
    S.checkins = snap.docs.map(d => ({ ...d.data(), id: d.id })); renderAll();
  }, onErr));
  S.unsubs.push(onSnapshot(collection(S.db, 'users', S.user.uid, 'notes'), snap => {
    S.myNotes = snap.docs.map(d => d.data()).sort((a,b) => a.at < b.at ? 1 : -1);
    if (S.open && S.form && !S.form.saving && document.activeElement && document.activeElement.id !== 'note') renderModal();
  }, () => {}));
  if (isAdmin()){
    S.unsubs.push(onSnapshot(collection(S.db, 'allowlist'), snap => {
      S.allowlist = snap.docs.map(d => ({ ...d.data(), id: d.id })).sort((a,b) => String(a.name).localeCompare(String(b.name)));
      if (S.admin) renderAdmin();
    }, () => {}));
  }
}
function failWrite(){ S.error = 'That didn’t save. Check your connection and try again.'; renderStatus(); }

// ---------- main render ----------
function renderHeader(){
  const m = deptMeta(S.dept);
  $('title').textContent = !S.me ? 'Care Check-In' : (S.dept === 'All' ? 'All departments' : S.dept);
  $('subtitle').textContent = !S.me ? '' : (S.dept === 'All' ? 'Everyone' : (m ? m.lead : ''));
  const me = $('me'); me.textContent = '';
  if (S.me) me.append(h('span', { class:'eyebrow' }, 'HI, ' + S.me.name.toUpperCase()),
    isAdmin() ? h('button', { class:'linkbtn', type:'button', onclick: () => openAdmin('people') }, 'Admin') : null,
    h('button', { class:'linkbtn', type:'button', onclick: () => signOut(S.auth) }, 'Sign out'));
  const chips = $('deptChips'); chips.textContent = '';
  if (!S.me) return;
  ['All'].concat(depts().map(d => d.name)).forEach(n => {
    chips.append(h('button', { class:'chip', type:'button', 'aria-pressed': S.dept === n ? 'true':'false',
      onclick: () => { S.dept = n; lsSet('care.dept', n); renderAll(); window.scrollTo(0,0); } }, n));
  });
}
function renderStatus(){
  const box = $('status'); box.textContent = '';
  let msg = S.error;
  if (!msg && S.me && S.got.config && !S.config) msg = isAdmin() ? 'Welcome! Open Admin → Settings and press “Set up departments” to get started.' : 'Ed hasn’t finished setting this up yet.';
  if (msg) box.append(h('div', { class:'notice', role:'status' }, msg));
}
function renderSummary(){
  const box = $('summary'); box.textContent = '';
  if (!S.me || !S.config || !S.got.people) return;
  const ps = activePeople().filter(inDept);
  const infos = ps.map(info);
  const n = { green:0, yellow:0, red:0 };
  infos.forEach(i => n[i.level]++);
  const total = ps.length || 1;
  const pct = Math.round(n.green / total * 100);
  const lvl = healthLevel(pct);
  const ratings = infos.map(i => i.rating).filter(x => x != null);
  const avg = ratings.length ? (ratings.reduce((a,b) => a+b, 0)/ratings.length).toFixed(1) : null;
  const seg = k => n[k] ? h('div', { style:'width:' + (n[k]/total*100) + '%;background:' + LEVEL[k].dot }) : null;
  box.append(h('section', { class:'card', 'aria-label':'Care health' },
    h('div', { class:'row', style:'align-items:flex-start' },
      h('div', null,
        h('div', { class:'label' }, S.dept === 'All' ? 'Whole team care health' : 'Department care health'),
        h('div', { class:'muted', style:'margin-top:2px' }, 'Checked on in the last 4 weeks'),
        h('span', { class:'level', style:'background:' + lvl.bg + ';color:' + lvl.fg }, lvl.name)),
      h('div', { style:'text-align:right' }, h('span', { class:'score', style:'color:' + lvl.fg }, pct + '%'),
        h('div', { class:'muted' }, n.green + ' of ' + ps.length + ' fit'))),
    h('div', { class:'stack', role:'img', 'aria-label': n.green + ' fit, ' + n.yellow + ' check soon, ' + n.red + ' overdue' }, seg('green'), seg('yellow'), seg('red')),
    h('div', { class:'grid3' },
      h('div', { class:'stat s-g' }, h('b', null, n.green), h('span', null, 'Fit · within 4 wks')),
      h('div', { class:'stat s-y' }, h('b', null, n.yellow), h('span', null, 'Check soon · 5–6 wks')),
      h('div', { class:'stat s-r' }, h('b', null, n.red), h('span', null, 'Overdue · 7+ wks'))),
    h('p', { class:'muted', style:'margin:12px 0 0' }, lvl.note + (avg ? ' How people are doing: ' + avg + '/10 on average.' : ''))));
  const r = round();
  box.append(h('div', { class:'grid2', style:'margin-top:12px' },
    h('div', { class:'card' }, h('div', { class:'label' }, 'Check-in round'), h('div', { style:'font-size:18px;font-weight:600;margin-top:4px' }, fmt(r.start) + ' – ' + fmt(r.end)), h('div', { class:'muted' }, 'Next starts ' + fmt(r.next))),
    h('div', { class:'card' }, h('div', { class:'label' }, 'Huddle'), h('div', { style:'font-size:18px;font-weight:600;margin-top:4px' }, fmt(r.huddle, true)), h('div', { class:'muted' }, 'Share how people are doing'))));
}
function renderConcerns(){
  const box = $('concerns'); box.textContent = '';
  if (!S.me) return;
  const byId = Object.fromEntries(S.people.map(p => [p.id, p]));
  const open = S.checkins.filter(c => c.concern && !c.resolved && byId[c.personId] && inDept(byId[c.personId]));
  if (!open.length) return;
  box.append(h('section', { class:'concern', 'aria-label':'Raised concerns' },
    h('h2', { class:'display', style:'font-size:28px' }, 'RAISED · ' + open.length),
    h('div', { class:'items' }, open.map(c => {
      const p = byId[c.personId];
      return h('div', { class:'item' },
        h('div', { class:'row' },
          h('button', { class:'btn ghost', style:'padding:0;text-align:left;font-size:16px', type:'button', onclick: () => openPerson(p.id) }, p.name),
          h('button', { class:'btn small', type:'button', onclick: async e => {
            e.target.disabled = true;
            try { await updateDoc(doc(S.db, 'checkins', c.id), { resolved:true, resolvedBy:S.user.uid, resolvedByName:S.me.name, resolvedAt:new Date().toISOString() }); }
            catch(err){ e.target.disabled = false; failWrite(); }
          } }, 'Handled')),
        h('div', { class:'muted' }, 'Raised by ' + whoName(c) + ', ' + fmt(parseYmd(c.date)) + ' · on the huddle agenda'));
    }))));
}
function renderList(){
  const list = $('list'); list.textContent = '';
  document.querySelectorAll('.fchip[data-f]').forEach(b => b.setAttribute('aria-pressed', b.dataset.f === S.filter ? 'true':'false'));
  if (!S.me){ $('countNote').textContent = ''; return; }
  if (!S.got.people){ list.append(h('div', { class:'empty' }, 'Loading…')); return; }
  const q = S.q.trim().toLowerCase();
  let rows = activePeople().filter(inDept).map(p => ({ p, i: info(p) }));
  $('countNote').textContent = rows.filter(x => x.i.level !== 'green').length + ' need a check-in';
  rows = rows.filter(x => {
    if (q && x.p.name.toLowerCase().indexOf(q) < 0) return false;
    if (S.filter === 'need') return x.i.level !== 'green';
    if (S.filter === 'fit') return x.i.level === 'green';
    return true;
  });
  const order = { red:0, yellow:1, green:2 };
  rows.sort((a,b) => {
    const ca = a.i.concern ? 0 : 1, cb = b.i.concern ? 0 : 1;
    if (ca !== cb) return ca - cb;
    if (order[a.i.level] !== order[b.i.level]) return order[a.i.level] - order[b.i.level];
    const da = a.i.days == null ? 99999 : a.i.days, db = b.i.days == null ? 99999 : b.i.days;
    if (da !== db) return db - da;
    return a.p.name.localeCompare(b.p.name);
  });
  if (!rows.length){
    list.append(h('div', { class:'empty' }, !S.people.length ? (isAdmin() ? 'No people yet. Open Admin → People to add or import them.' : 'No people added yet.') : (S.filter === 'need' && !q ? 'Everyone here is fit. Well done!' : 'Nobody matches.')));
    return;
  }
  rows.forEach(({ p, i }) => {
    const L = LEVEL[i.level];
    const where = [p.team || p.dept || 'Unassigned', p.dept2 && S.dept === 'All' ? '+ ' + p.dept2 : null].filter(Boolean).join(' ');
    const lastTxt = i.last ? ago(i.days) + ' · ' + whoName(i.last) : 'Never checked on';
    const quick = h('button', { class:'check', type:'button', 'aria-label':'Mark ' + p.name + ' as checked on today', onclick: e => quickCheck(p, e.currentTarget) }, 'Checked');
    quick.insertAdjacentHTML('afterbegin', '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>');
    list.append(h('div', { class:'person' },
      h('span', { class:'edge', style:'background:' + L.dot, 'aria-hidden':'true' }),
      h('button', { class:'open', type:'button', onclick: () => openPerson(p.id) },
        h('span', { class:'avatar', style:'background:' + L.bg + ';color:' + L.fg, 'aria-hidden':'true' }, initials(p.name)),
        h('span', { class:'grow' },
          h('div', { class:'pname' }, p.name),
          h('div', { class:'muted' }, h('strong', { style:'color:' + L.fg }, L.label), ' · ' + lastTxt),
          h('div', { class:'muted' }, where))),
      i.concern ? h('span', { class:'pill p-or' }, 'Raised') : null, quick));
  });
}
function renderAll(){ renderHeader(); renderStatus(); renderSummary(); renderConcerns(); renderList(); }

async function quickCheck(p, btn){
  btn.disabled = true;
  try {
    const ref = await addDoc(collection(S.db, 'checkins'), { personId:p.id, by:S.user.uid, byName:S.me.name, at:new Date().toISOString(), date:ymd(new Date()), rating:null, concern:false, resolved:false, quick:true });
    toast(p.name.split(' ')[0] + ' marked as checked on.', async () => { try { await deleteDoc(ref); } catch(e){ failWrite(); } });
  } catch(err){ btn.disabled = false; failWrite(); }
}

// ---------- person sheet ----------
function openPerson(id){ S.open = id; S.form = { rating:null, note:'', concern:false, msg:'', saving:false, tpl:-1 }; renderModal(); }
function closePerson(){ S.open = null; S.form = null; $('modal').textContent = ''; document.body.style.overflow = ''; }
const MSGS = [
  'Hi {n}! Just thinking of you this week. Thank you for everything you pour into our kids. How are you doing, really? Anything I can pray for?',
  'Hey {n}! Checking in on you. How’s your week been? Thank you for serving with Favor Kids, it means a lot. Let me know how I can pray for you.',
  'Hi {n}! You crossed my mind today. How are you and your family? Would love to grab coffee after service soon.',
  'Hello {n}! Just wanted to say we’re so grateful for you. How’s your heart these days? Anything going on that I can pray about?',
  'Hi {n}! Hope your week is going well. How are you holding up with everything? I’m here if you ever want to talk.'
];
function myNotesBlock(p){
  const mine = S.myNotes.filter(n => n.personId === p.id);
  if (!mine.length) return h('section', { class:'card' }, h('strong', null, 'Your last note'), h('p', { class:'muted', style:'margin:6px 0 0' }, 'You haven’t written a note for ' + p.name.split(' ')[0] + ' yet.'));
  const [last, ...older] = mine;
  return h('section', { class:'card', style:'background:var(--blue-l)' },
    h('div', { class:'row' }, h('strong', null, 'Your last note'), h('span', { class:'muted' }, 'Only you see this')),
    h('div', { class:'muted', style:'margin-top:6px' }, fmt(parseYmd(last.date), true) + (last.rating != null ? ' · ' + last.rating + '/10' : '')),
    h('p', { style:'margin:6px 0 0;font-size:16px;line-height:1.4;white-space:pre-line' }, last.note),
    older.length ? h('details', { style:'margin-top:10px' }, h('summary', { style:'cursor:pointer;font-weight:600;min-height:32px' }, 'Your earlier notes (' + older.length + ')'),
      older.slice(0, 20).map(n => h('div', { class:'hist' }, h('span', { style:'white-space:pre-line' }, n.note), h('span', { class:'muted' }, fmt(parseYmd(n.date)))))) : null);
}
function renderModal(){
  const p = S.people.find(x => x.id === S.open);
  const box = $('modal'); box.textContent = '';
  if (!p) return;
  document.body.style.overflow = 'hidden';
  const f = S.form, r = round(), i = info(p), L = LEVEL[i.level];
  const fit = [p.pool ? 'Any ' + (p.pool === 'Women' ? 'woman' : 'man') : null, p.careBy || null].filter(Boolean).join(' · ') || 'Anyone';
  const scale = h('div', { class:'scale', role:'group', 'aria-label':'Rating from 1 to 10' });
  for (let n = 1; n <= 10; n++) scale.append(h('button', { type:'button', 'aria-pressed': f.rating === n ? 'true':'false', onclick: () => { f.rating = (f.rating === n ? null : n); renderModal(); } }, String(n)));
  const note = h('textarea', { id:'note', rows:'4', placeholder:'Prayer needs, wins, what’s going on…' });
  note.value = f.note; note.addEventListener('input', () => { f.note = note.value; });
  let msgBlock = null;
  if (f.msg){
    const copyBtn = h('button', { class:'btn solid small', type:'button', onclick: () => {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(f.msg).then(() => { copyBtn.textContent = 'Copied'; }, () => { copyBtn.textContent = 'Select & copy above'; });
      else copyBtn.textContent = 'Select & copy above';
    } }, 'Copy');
    msgBlock = h('div', { style:'display:flex;flex-direction:column;gap:8px;margin-top:12px' }, h('div', { class:'msg' }, f.msg), h('div', null, copyBtn));
  }
  const genBtn = h('button', { class:'btn small', type:'button', onclick: () => { f.tpl = (f.tpl + 1) % MSGS.length; f.msg = MSGS[f.tpl].replace('{n}', p.name.split(' ')[0]); renderModal(); } }, f.msg ? 'Try another' : 'Generate a message');
  const saveBtn = h('button', { class:'save', type:'button', disabled: f.saving || null, onclick: async () => {
    if (f.saving) return;
    f.saving = true; saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const at = new Date().toISOString(), date = ymd(new Date());
      const ref = await addDoc(collection(S.db, 'checkins'), { personId:p.id, by:S.user.uid, byName:S.me.name, at, date, rating:f.rating, concern:!!f.concern, resolved:false });
      const txt = f.note.trim();
      if (txt) await setDoc(doc(S.db, 'users', S.user.uid, 'notes', ref.id), { personId:p.id, checkinId:ref.id, at, date, note:txt, rating:f.rating });
      closePerson(); toast('Check-in saved for ' + p.name.split(' ')[0] + '.');
    } catch(err){ f.saving = false; saveBtn.disabled = false; saveBtn.textContent = 'Save check-in'; failWrite(); }
  } }, 'Save check-in');
  const hist = i.all.slice(0, 8).map(c => h('div', { class:'hist' },
    h('span', null, fmt(parseYmd(c.date)) + ' · ' + whoName(c) + (c.concern ? (c.resolved ? ' · concern handled' : ' · raised') : '')),
    h('strong', null, c.rating != null ? c.rating + '/10' : '✓')));
  const sheet = h('div', { class:'sheet', role:'dialog', 'aria-modal':'true', 'aria-labelledby':'pTitle' },
    h('header', null,
      h('div', { class:'row' }, h('span', { class:'eyebrow' }, (p.dept || 'Unassigned') + (p.dept2 ? ' + ' + p.dept2 : '')),
        h('button', { class:'chip', type:'button', onclick: closePerson }, 'Close')),
      h('h1', { id:'pTitle', style:'font-size:44px' }, p.name),
      h('p', { class:'sub' }, (p.team ? p.team + ' · ' : '') + 'Best fit: ' + fit),
      p.confirm ? h('div', { style:'margin-top:10px' }, h('span', { class:'pill', style:'background:var(--yellow);color:var(--ink)' }, 'To confirm: ' + p.confirm)) : null),
    h('div', { class:'body' },
      h('section', { class:'lastbox', style:'background:' + L.bg + ';color:' + L.fg, 'aria-label':'Last check-in' },
        h('span', { class:'bigdot', style:'background:' + L.dot, 'aria-hidden':'true' }),
        h('div', null,
          h('div', { style:'font-size:20px;font-weight:600' }, L.label + ' · ' + ago(i.days)),
          h('div', { style:'font-size:14px' }, i.last ? 'Last checked on ' + fmt(parseYmd(i.last.date), true) + ' by ' + whoName(i.last) + (i.rating != null ? ' · last rating ' + i.rating + '/10' : '') : 'No check-ins yet. Be the first!'))),
      myNotesBlock(p),
      h('section', { class:'card' }, h('div', { class:'row' }, h('strong', null, 'Reach out'), genBtn), msgBlock),
      h('section', { class:'card' }, h('div', { class:'row' }, h('strong', null, 'How are they?'), h('span', { class:'muted' }, '1 struggling · 10 thriving')), scale),
      h('section', { class:'card' }, h('label', { for:'note', style:'font-weight:600;display:block;margin-bottom:4px' }, 'Anything to note?'),
        h('div', { class:'muted', style:'margin-bottom:8px' }, 'Private: only you can see your notes.'), note),
      h('section', { class:'card' },
        h('strong', null, 'Big concern?'),
        h('p', { class:'muted', style:'margin:4px 0 10px' }, f.concern ? 'This will show at the top of the page and go on the ' + fmt(r.huddle) + ' huddle agenda.' : 'A crisis, a hospital stay, a family loss? Raise it so it’s seen right away.'),
        h('button', { class:'flag', type:'button', 'aria-pressed': f.concern ? 'true':'false', onclick: () => { f.concern = !f.concern; renderModal(); } }, f.concern ? 'Concern raised' : 'Raise a concern')),
      saveBtn,
      hist.length ? h('section', { style:'display:flex;flex-direction:column;gap:8px;padding:4px' }, h('strong', { class:'muted' }, 'Past check-ins'), hist) : null));
  const ov = h('div', { class:'overlay', onclick: e => { if (e.target === ov) closePerson(); } }, sheet);
  box.append(ov);
}

// ---------- admin ----------
function openAdmin(tab){ S.admin = { tab, editing:null, importText:'', importMsg:'' }; renderAdmin(); }
function closeAdmin(){ S.admin = null; $('admin').textContent = ''; document.body.style.overflow = ''; }
const DEFAULT_DEPTS = [
  { name:'Experience', lead:'Ricki' }, { name:'People', lead:'Alecks' }, { name:'Curriculum', lead:'Billy' },
  { name:'Operations', lead:'Tanya, with Aina & Marco' }, { name:'Rooms', lead:'Claud' }
];
function deptSelect(id, value, withAll, withNone){
  const sel = h('select', { id, class:'inp' });
  const opts = (withNone ? [''] : []).concat(withAll ? ['All'] : []).concat(depts().map(d => d.name));
  opts.forEach(o => sel.append(h('option', { value:o }, o || '—')));
  sel.value = value || '';
  return sel;
}
function field(label, input){ return h('div', { class:'field' }, h('label', { for:input.id }, label), input); }
function textInput(id, value, ph){ const i = h('input', { id, class:'inp', placeholder: ph || null }); i.value = value || ''; return i; }

function renderAdmin(){
  const box = $('admin'); box.textContent = '';
  if (!S.admin || !isAdmin()) return;
  document.body.style.overflow = 'hidden';
  const A = S.admin;
  const tab = (key, label) => h('button', { class:'fchip', type:'button', 'aria-pressed': A.tab === key ? 'true':'false', onclick: () => { A.tab = key; A.editing = null; renderAdmin(); } }, label);
  const body = h('div', { class:'body' }, h('div', { class:'tabs' }, tab('people', 'People'), tab('leaders', 'Leaders'), tab('settings', 'Settings')));

  if (A.tab === 'people'){
    if (A.editing){
      const p = A.editing === 'new' ? { active:true } : (S.people.find(x => x.id === A.editing) || {});
      const name = textInput('a-name', p.name), team = textInput('a-team', p.team), careBy = textInput('a-care', p.careBy, 'e.g. Ricki or Claud'), confirm = textInput('a-confirm', p.confirm);
      const d1 = deptSelect('a-dept', p.dept, false, true), d2 = deptSelect('a-dept2', p.dept2, false, true);
      const pool = h('select', { id:'a-pool', class:'inp' }, h('option', { value:'' }, 'Anyone'), h('option', { value:'Women' }, 'Any woman'), h('option', { value:'Men' }, 'Any man'));
      pool.value = p.pool || '';
      body.append(h('section', { class:'card', style:'display:flex;flex-direction:column;gap:10px' },
        h('strong', { style:'font-size:18px' }, A.editing === 'new' ? 'Add a person' : 'Edit ' + p.name),
        field('Name', name),
        h('div', { class:'formgrid' }, field('Department', d1), field('Also in', d2), field('Team', team), field('Who can check in', pool)),
        field('Cared for by (optional)', careBy), field('Note to confirm (optional)', confirm),
        h('div', { style:'display:flex;gap:8px;flex-wrap:wrap' },
          h('button', { class:'btn solid', type:'button', onclick: async e => {
            const nm = name.value.trim(); if (!nm) { name.focus(); return; }
            e.target.disabled = true;
            const data = { name:nm, dept:d1.value, dept2:d2.value || null, team:team.value.trim() || null, pool:pool.value || null, careBy:careBy.value.trim() || null, confirm:confirm.value.trim() || null, active:true };
            const id = A.editing === 'new' ? (S.people.some(x => x.id === slug(nm)) ? slug(nm) + '-' + Date.now().toString(36) : slug(nm)) : A.editing;
            try { await setDoc(doc(S.db, 'people', id), data, { merge:true }); A.editing = null; renderAdmin(); toast('Saved ' + nm + '.'); }
            catch(err){ e.target.disabled = false; toast('Couldn’t save. Try again.'); }
          } }, 'Save'),
          h('button', { class:'btn', type:'button', onclick: () => { A.editing = null; renderAdmin(); } }, 'Cancel'),
          A.editing !== 'new' ? h('button', { class:'btn', style:'border-color:var(--r);color:var(--r-t)', type:'button', onclick: async () => {
            try { await updateDoc(doc(S.db, 'people', A.editing), { active:false }); A.editing = null; renderAdmin(); toast(p.name + ' removed from the list.'); }
            catch(err){ toast('Couldn’t remove. Try again.'); }
          } }, 'Remove from list') : null)));
    } else {
      const ta = h('textarea', { id:'a-import', rows:'6', placeholder:'Name | Department | Also in | Team | Any woman/Any man | Cared for by' });
      ta.value = A.importText; ta.addEventListener('input', () => { A.importText = ta.value; });
      body.append(
        h('div', { style:'display:flex;gap:8px;flex-wrap:wrap' }, h('button', { class:'btn solid', type:'button', onclick: () => { A.editing = 'new'; renderAdmin(); } }, 'Add a person')),
        h('section', { class:'card', style:'display:flex;flex-direction:column;gap:8px' },
          h('strong', null, 'Import a list'),
          h('p', { class:'muted', style:'margin:0' }, 'One person per line: Name | Department | Also in | Team | Any woman or Any man | Cared for by. Only the name is required. People already on the list are updated.'),
          ta, A.importMsg ? h('div', { class:'ok' }, A.importMsg) : null,
          h('div', null, h('button', { class:'btn', type:'button', onclick: e => importList(e.target) }, 'Import'))),
        h('section', { class:'card' },
          h('strong', null, 'Everyone (' + activePeople().length + ')'),
          activePeople().map(p => h('div', { class:'adminrow' },
            h('span', null, h('div', { style:'font-weight:600' }, p.name), h('div', { class:'muted' }, [p.dept || 'Unassigned', p.dept2, p.team].filter(Boolean).join(' · '))),
            h('button', { class:'btn small', type:'button', onclick: () => { A.editing = p.id; renderAdmin(); } }, 'Edit')))));
    }
  }

  if (A.tab === 'leaders'){
    const email = textInput('l-email', '', 'name@email.com'), name = textInput('l-name', '', 'e.g. Tanya');
    email.type = 'email';
    const dept = deptSelect('l-dept', 'All', true, false);
    const role = h('select', { id:'l-role', class:'inp' }, h('option', { value:'lead' }, 'Leader'), h('option', { value:'admin' }, 'Admin (can edit lists)'));
    body.append(
      h('section', { class:'card', style:'display:flex;flex-direction:column;gap:10px' },
        h('strong', { style:'font-size:18px' }, 'Add a leader'),
        h('p', { class:'muted', style:'margin:0' }, 'Only emails on this list can create an account and sign in.'),
        h('div', { class:'formgrid' }, field('Email', email), field('Name', name), field('Opens on', dept), field('Role', role)),
        h('div', null, h('button', { class:'btn solid', type:'button', onclick: async e => {
          const em = email.value.trim().toLowerCase(), nm = name.value.trim();
          if (!em || em.indexOf('@') < 1){ email.focus(); return; }
          if (!nm){ name.focus(); return; }
          e.target.disabled = true;
          try { await setDoc(doc(S.db, 'allowlist', em), { name:nm, dept:dept.value, role:role.value }); toast(nm + ' can now create an account with ' + em + '.'); renderAdmin(); }
          catch(err){ e.target.disabled = false; toast('Couldn’t add. Try again.'); }
        } }, 'Add leader'))),
      h('section', { class:'card' },
        h('strong', null, 'Leaders (' + S.allowlist.length + ')'),
        S.allowlist.map(l => h('div', { class:'adminrow' },
          h('span', null, h('div', { style:'font-weight:600' }, l.name + (l.role === 'admin' ? ' · Admin' : '')), h('div', { class:'muted' }, l.id + ' · ' + (l.dept || 'All'))),
          l.id === S.me.email ? h('span', { class:'muted' }, 'You') : h('button', { class:'btn small', type:'button', onclick: async () => {
            try { await deleteDoc(doc(S.db, 'allowlist', l.id)); toast(l.name + ' removed.'); } catch(err){ toast('Couldn’t remove. Try again.'); }
          } }, 'Remove')))));
  }

  if (A.tab === 'settings'){
    if (!S.config){
      body.append(h('section', { class:'card', style:'display:flex;flex-direction:column;gap:10px' },
        h('strong', null, 'First-time setup'),
        h('p', { class:'muted', style:'margin:0' }, 'Creates the five departments (Experience, People, Curriculum, Operations, Rooms) and starts two-week rounds this week.'),
        h('div', null, h('button', { class:'btn solid', type:'button', onclick: async e => {
          e.target.disabled = true;
          const t = today(); const monday = addDays(t, -((t.getDay() + 6) % 7));
          try { await setDoc(doc(S.db, 'config', 'main'), { roundStart: ymd(monday), roundDays:14, huddleOffset:13, depts: DEFAULT_DEPTS }); toast('All set up.'); }
          catch(err){ e.target.disabled = false; toast('Couldn’t set up. Check the Firestore rules.'); }
        } }, 'Set up departments'))));
    } else {
      const start = h('input', { id:'s-start', type:'date', class:'inp' }); start.value = S.config.roundStart || '';
      const days = h('select', { id:'s-days', class:'inp' }, h('option', { value:'7' }, 'Every week'), h('option', { value:'14' }, 'Every 2 weeks'), h('option', { value:'28' }, 'Every 4 weeks'));
      days.value = String(S.config.roundDays || 14);
      const dl = h('textarea', { id:'s-depts', rows:'6' });
      dl.value = depts().map(d => d.name + ' | ' + (d.lead || '')).join('\n');
      body.append(h('section', { class:'card', style:'display:flex;flex-direction:column;gap:10px' },
        h('strong', { style:'font-size:18px' }, 'Settings'),
        h('div', { class:'formgrid' }, field('A round started on', start), field('Rounds', days)),
        h('p', { class:'muted', style:'margin:0' }, 'The huddle is the last day of each round.'),
        field('Departments (Name | Lead), one per line', dl),
        h('div', null, h('button', { class:'btn solid', type:'button', onclick: async e => {
          const list = dl.value.split('\n').map(l => l.split('|').map(x => x.trim())).filter(x => x[0]).map(x => ({ name:x[0], lead:x[1] || '' }));
          const nd = parseInt(days.value, 10);
          e.target.disabled = true;
          try { await updateDoc(doc(S.db, 'config', 'main'), { roundStart: start.value || S.config.roundStart, roundDays: nd, huddleOffset: nd - 1, depts: list }); toast('Settings saved.'); e.target.disabled = false; }
          catch(err){ e.target.disabled = false; toast('Couldn’t save. Try again.'); }
        } }, 'Save settings'))));
    }
  }

  const sheet = h('div', { class:'sheet', role:'dialog', 'aria-modal':'true', 'aria-labelledby':'adTitle' },
    h('header', null, h('div', { class:'row' }, h('h1', { id:'adTitle', style:'font-size:40px;margin:0' }, 'ADMIN'), h('button', { class:'chip', type:'button', onclick: closeAdmin }, 'Close'))),
    body);
  const ov = h('div', { class:'overlay', onclick: e => { if (e.target === ov) closeAdmin(); } }, sheet);
  box.append(ov);
}
async function importList(btn){
  const A = S.admin;
  const lines = (A.importText || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;
  btn.disabled = true;
  const known = new Set(depts().map(d => d.name.toLowerCase()));
  const deptName = v => { const x = (v || '').trim(); if (!x) return ''; const m = depts().find(d => d.name.toLowerCase() === x.toLowerCase()); return m ? m.name : x; };
  try {
    let batch = writeBatch(S.db), n = 0, total = 0;
    for (const line of lines){
      const c = line.split('|').map(x => x.trim());
      if (!c[0]) continue;
      const poolRaw = (c[4] || '').toLowerCase();
      const data = { name:c[0], dept:deptName(c[1]), dept2:deptName(c[2]) || null, team:c[3] || null,
        pool: poolRaw.includes('wom') ? 'Women' : (poolRaw.includes('man') || poolRaw.includes('men') ? 'Men' : null),
        careBy:c[5] || null, active:true };
      batch.set(doc(S.db, 'people', slug(c[0])), data, { merge:true });
      n++; total++;
      if (n === 400){ await batch.commit(); batch = writeBatch(S.db); n = 0; }
    }
    if (n) await batch.commit();
    A.importText = ''; A.importMsg = 'Imported ' + total + (total === 1 ? ' person.' : ' people.');
    renderAdmin();
  } catch(err){ btn.disabled = false; toast('Couldn’t import. Check the format and try again.'); }
  void known;
}

// ---------- wiring ----------
$('search').addEventListener('input', e => { S.q = e.target.value; renderList(); });
document.querySelectorAll('.fchip[data-f]').forEach(b => b.addEventListener('click', () => { S.filter = b.dataset.f; renderList(); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape'){ if (S.open) closePerson(); else if (S.admin) closeAdmin(); } });

function boot(){
  renderAll();
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.apiKey){ LG.step = 'setup'; renderLogin(); return; }
  const app = initializeApp(cfg);
  S.auth = getAuth(app); S.db = getFirestore(app);
  LG.step = 'loading'; renderLogin();
  onAuthStateChanged(S.auth, u => { afterAuth(u); });
}
boot();
