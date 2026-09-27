/*!
 * MVP Instagram Tracker v2.1
 * https://github.com/trader1ek/MVP-INSTAGRAM-TRACKER
 * Built on HenryLok0/Instagram_Follower_Checker + davidarroyo1234/InstagramUnfollowers (MIT).
 * Usage: log in on instagram.com → open the console → paste this whole file → Enter.
 * All data stays in your browser; nothing is sent anywhere.
 */
(() => {
  'use strict';

  if (location.hostname !== 'www.instagram.com') {
    alert('Go to www.instagram.com and log in first, then paste the code into the console again.');
    location.href = 'https://www.instagram.com/';
    return;
  }
  if (window.__IGTA__) { window.__IGTA__.open(); return; }

  /* ───────────────────────── Constants & storage ───────────────────────── */
  const APP_ID = '936619743392459';
  const PAGE_SIZE = 100;
  const MAX_PAGES = 600;
  const NO_PIC_IDS = ['44884218_345707102882519_2446069589734326272_n', '464760996_1254146839119862_3605321457742435801_n'];
  const K_SETTINGS = 'igta_settings', K_WL = 'igta_whitelist';

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const DEFAULTS = {
    pageDelaySec: 1,        // scan: delay between pages
    longPauseEvery: 6,      // scan: long pause every N pages
    longPauseSec: 10,       // scan: long pause length
    unfollowDelaySec: 4,    // unfollow: delay between actions
    unfollowBatch: 5,       // unfollow: pause every N actions
    unfollowBatchPauseMin: 5, // unfollow: pause length (minutes)
    verify: 'me',           // verification: 'me' = my account only · 'all' = all accounts · 'off' = disabled
  };
  let settings = { ...DEFAULTS, ...store.get(K_SETTINGS, {}) };
  const whitelist = new Map(Object.entries(store.get(K_WL, {}))); // id -> username
  const saveWL = () => store.set(K_WL, Object.fromEntries(whitelist));

  // Persistent memory — IndexedDB (so we don't fill instagram.com's own localStorage).
  // Record: { id, username, pic, isMe, scans, snapshot: { at, followers[], following[] }, events[] }
  const IDB = { name: 'igta', store: 'accounts' };
  let idbConn = null;
  function idbOpen() {
    if (idbConn) return idbConn;
    idbConn = new Promise((res, rej) => {
      const r = indexedDB.open(IDB.name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(IDB.store, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => { idbConn = null; rej(r.error); };
    });
    return idbConn;
  }
  async function idbReq(mode, fn) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB.store, mode);
      const r = fn(tx.objectStore(IDB.store));
      tx.oncomplete = () => res(r ? r.result : undefined);
      tx.onerror = tx.onabort = () => rej(tx.error);
    });
  }
  const dbGet = (id) => idbReq('readonly', (st) => st.get(id));
  const dbPut = (rec) => idbReq('readwrite', (st) => st.put(rec));
  const dbDel = (id) => idbReq('readwrite', (st) => st.delete(id));
  const dbAll = () => idbReq('readonly', (st) => st.getAll());

  /* ───────────────────────── Helpers ───────────────────────── */
  const rand = (a, b) => a + Math.random() * (b - a);
  const getCookie = (n) => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; };
  const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString('en-GB'));
  const today = () => new Date().toISOString().slice(0, 10);

  class StopSignal extends Error {}
  class HttpError extends Error { constructor(status, msg, body) { super(msg); this.status = status; this.body = body; } }

  const S = {
    screen: 'start', target: null, data: null, tab: 'notBack', q: '', page: 1,
    f: { hideVerified: false, hidePrivate: false, onlyNoPic: false, hideWhitelisted: true },
    selected: new Set(), ctrl: { paused: false, stopped: false },
    scan: { phase: '', following: 0, followers: 0, msg: '' },
    unf: null, lastQuery: '', sort: 'az', histId: null, histFilter: 'all',
    history: [], cmp: { ids: new Set(), mode: 'followers', q: '' },
  };

  // Sleep that respects stop/pause
  async function wait(ms) {
    const end = Date.now() + Math.max(0, ms);
    while (Date.now() < end || S.ctrl.paused) {
      if (S.ctrl.stopped) throw new StopSignal();
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(10, end - Date.now()))));
    }
    if (S.ctrl.stopped) throw new StopSignal();
  }

  async function igGet(path) {
    const r = await fetch('https://www.instagram.com' + path, {
      credentials: 'include',
      headers: { 'X-IG-App-ID': APP_ID, 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': getCookie('csrftoken') || '' },
    });
    let body = null;
    try { body = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) throw new HttpError(r.status, `HTTP ${r.status}${body?.message ? ' – ' + body.message : ''}`, body);
    if (!body) { const e = new HttpError(r.status, 'Instagram did not return JSON (temporary throttling or session problem)'); e.soft = true; throw e; }
    return body;
  }

  const normUser = (u) => ({
    id: String(u.pk_id ?? u.pk ?? u.id),
    username: u.username || '',
    full_name: u.full_name || '',
    pic: u.profile_pic_url || '',
    is_private: !!u.is_private,
    is_verified: !!u.is_verified,
    noPic: NO_PIC_IDS.some((x) => (u.profile_pic_url || '').includes(x)),
  });

  /* ───────────────────────── Instagram API ───────────────────────── */
  async function resolveTarget(username) {
    const me = getCookie('ds_user_id');
    if (!me) throw new Error('You do not seem to be logged in. Log in to Instagram first.');

    if (!username) {
      let info = null;
      try { info = (await igGet(`/api/v1/users/${me}/info/`)).user; } catch { /* counts are optional */ }
      return {
        id: me, isMe: true, username: info?.username || 'my account', full_name: info?.full_name || '',
        pic: info?.profile_pic_url || '', followerCount: info?.follower_count, followingCount: info?.following_count,
      };
    }

    const uname = username.toLowerCase();
    // 1) Profile info (more reliable, also returns counts)
    try {
      const u = (await igGet(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(uname)}`))?.data?.user;
      if (u?.id) {
        if (u.is_private && !u.followed_by_viewer && String(u.id) !== me)
          throw new Error(`@${u.username} is a private account you don't follow; its lists are not visible.`);
        return {
          id: String(u.id), isMe: String(u.id) === me, username: u.username, full_name: u.full_name || '',
          pic: u.profile_pic_url || '', isPrivate: u.is_private,
          followerCount: u.edge_followed_by?.count, followingCount: u.edge_follow?.count,
        };
      }
    } catch (e) {
      if (!(e instanceof HttpError)) throw e; // pass the private-account error through
    }
    // 2) Fallback: search (Henry's method)
    const d = await igGet(`/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(uname)}&include_reel=false`);
    const hit = d.users?.find((x) => x.user?.username?.toLowerCase() === uname)?.user;
    if (!hit) throw new Error(`@${username} not found. Check the username.`);
    const id = String(hit.pk_id ?? hit.pk);
    let info = null;
    try { info = (await igGet(`/api/v1/users/${id}/info/`)).user; } catch { /* counts are optional */ }
    return { id, isMe: id === me, username: hit.username, full_name: hit.full_name || '', pic: hit.profile_pic_url || '',
      isPrivate: info?.is_private ?? hit.is_private, followerCount: info?.follower_count, followingCount: info?.following_count };
  }

  // Retries 429 / 5xx / network errors up to 4 times with increasing backoff
  async function igGetRetry(path) {
    for (let retries = 0; ; retries++) {
      try {
        return await igGet(path);
      } catch (e) {
        if (e instanceof StopSignal) throw e;
        const transient = !(e instanceof HttpError) || e.soft || e.status === 429 || e.status >= 500;
        if (!transient || retries >= (e.soft ? 2 : 4)) throw e;
        const sec = Math.min(60 * 2 ** retries, 300);
        S.scan.msg = `Instagram is throttling (${e.message}). Retrying in ${sec}s… (${retries + 1}/4)`;
        updateScan();
        await wait(sec * 1000);
        S.scan.msg = '';
      }
    }
  }

  // Diagnostics log — can be copied from the results screen (contains no usernames)
  const diag = [];
  const logDiag = (o) => { diag.push(o); if (diag.length > 1500) diag.shift(); };

  // Paginated list fetch — loop (no recursion), de-duplicated by ID.
  // opts.count: page size · opts.surface: search_surface param · opts.offset: step by numeric offset instead of
  // the cursor (fallback when Instagram's cursor skips people) · opts.expected: target count
  // seed: users from earlier passes (to merge with)
  async function fetchList(kind, userId, onProgress, opts = {}, seed = []) {
    const { count = 50, surface = kind === 'followers', offset = false, expected = 0, pass = 1, query = '', order = '' } = opts;
    const users = seed.slice(), seen = new Set(seed.map((u) => u.id));
    let maxId = offset ? '0' : null, pages = 0, idle = 0, off = 0, raw = 0;
    try {
      for (;;) {
        await wait(0);
        let path = `/api/v1/friendships/${userId}/${kind}/?count=${count}`;
        if (surface) path += '&search_surface=follow_list_page';
        if (query) path += `&query=${encodeURIComponent(query)}`;
        if (order) path += `&order=${order}`;
        if (maxId && maxId !== '0') path += `&max_id=${encodeURIComponent(maxId)}`;

        let data;
        try {
          data = await igGetRetry(path);
        } catch (e) {
          if (e instanceof StopSignal) throw e;
          logDiag({ kind, pass, page: pages, error: e.message });
          return { users, complete: false, error: `${kind === 'followers' ? 'Followers' : 'Following'} list stopped early: ${e.message}` };
        }

        const batch = data.users || [];
        raw += batch.length;
        let added = 0;
        for (const raw of batch) {
          const u = normUser(raw);
          if (!seen.has(u.id)) { u.ord = pass === 1 ? users.length : 100000 + users.length; seen.add(u.id); users.push(u); added++; }
        }
        onProgress(users.length);
        pages++;
        // Only truly empty pages count; a page with "no new people" does not mean the list ended
        // (in extra passes everyone on the first pages is already known; the missing ones may be near the end)
        idle = batch.length ? 0 : idle + 1;
        logDiag({ kind, pass, page: pages, count, surface, offset, query: query || undefined, order: order || undefined, got: batch.length, added, total: users.length,
          next: data.next_max_id ?? null, has_more: data.has_more ?? null, big_list: data.big_list ?? null, page_size: data.page_size ?? null });

        // Stop conditions. Instagram can return an empty page mid-list, so we keep going
        // until 3 consecutive empty pages instead of stopping at the first one.
        let more;
        if (offset) {
          off += count;
          more = idle < 3 || off < expected;
          if (off > Math.max(expected, users.length) + count * 5) more = false;
          maxId = String(off);
        } else {
          const next = data.next_max_id;
          more = !!next && next !== maxId && idle < 3;
          maxId = next;
        }
        if (pass > 1 && expected && users.length >= expected) more = false; // target reached
        if (!more) return { users, complete: true, raw };
        if (pages >= MAX_PAGES) return { users, complete: false, error: 'Page safety limit reached.' };

        S.scan.msg = '';
        await wait(rand(settings.pageDelaySec * 700, settings.pageDelaySec * 1500) + rand(300, 1200));
        if (settings.longPauseEvery > 0 && pages % settings.longPauseEvery === 0) {
          const sec = Math.max(0, settings.longPauseSec + rand(-3, 3));
          S.scan.msg = `Pausing ${Math.round(sec)}s to avoid a block…`;
          updateScan();
          await wait(sec * 1000);
          S.scan.msg = '';
        }
      }
    } catch (e) {
      if (e instanceof StopSignal) return { users, complete: false, error: 'Scan stopped because you stopped it.' };
      throw e;
    }
  }

  function derive(d) {
    const fr = new Set(d.followers.map((u) => u.id)), fg = new Set(d.following.map((u) => u.id));
    d.notBack = d.following.filter((u) => !fr.has(u.id));
    d.fans = d.followers.filter((u) => !fg.has(u.id));
    d.mutual = d.following.filter((u) => fr.has(u.id));
    return d;
  }

  const MAX_VERIFY = 300;
  // kind='followers' → "does u follow the target?"  kind='following' → "does the target follow u?"
  async function relationExists(t, kind, u) {
    if (t.isMe) {
      // Your own account: Instagram's direct relationship info — the most reliable method
      try {
        const r = await igGetRetry(`/api/v1/friendships/show/${u.id}/`);
        if (typeof r.followed_by === 'boolean') return kind === 'followers' ? r.followed_by : r.following;
      } catch (e) { if (e instanceof StopSignal) throw e; }
    }
    // Other account (or fallback): search the target's list for this username
    let path = `/api/v1/friendships/${t.id}/${kind}/?count=12&query=${encodeURIComponent(u.username)}`;
    if (kind === 'followers') path += '&search_surface=follow_list_page';
    const r = await igGetRetry(path);
    return (r.users || []).some((x) => String(x.pk_id ?? x.pk) === u.id);
  }

  async function verifyCandidates(t, d) {
    const cands = [
      ...(d.complete.followers ? d.notBack.map((u) => ['followers', u]) : []),
      ...(d.complete.following ? d.fans.map((u) => ['following', u]) : []),
    ];
    if (!cands.length) return;
    if (cands.length > MAX_VERIFY) {
      d.verifyNote = `${fmt(cands.length)} suspects — too many to verify one by one (limit ${MAX_VERIFY}), skipped.`;
      return;
    }
    S.scan.phase = 'Verifying results one by one…';
    S.scan.verify = { done: 0, total: cands.length, fixed: 0 };
    updateScan();
    try {
      for (const [kind, u] of cands) {
        await wait(rand(settings.pageDelaySec * 600, settings.pageDelaySec * 1200) + rand(200, 700));
        let exists = null;
        try { exists = await relationExists(t, kind, u); } catch (e) { if (e instanceof StopSignal) throw e; }
        if (exists === true) {
          d[kind].push(u); // the list skipped them — add
          S.scan.verify.fixed++;
        } else if (exists === false) {
          d.verified.add(u.id);
        }
        S.scan.verify.done++;
        updateScan();
        if (S.scan.verify.done % 20 === 0) await wait(Math.max(0, settings.longPauseSec * 500));
      }
    } catch (e) {
      if (!(e instanceof StopSignal)) throw e;
      d.verifyNote = 'Verification was interrupted; double-check the entries without a "verified" tag.';
    }
    if (S.scan.verify.fixed) d.fixedCount = S.scan.verify.fixed;
  }

  const MAX_EVENTS = 3000, MAX_LOST_VERIFY = 60;
  const slimU = (u) => ({ id: u.id, username: u.username, full_name: u.full_name || '' });
  const snapOf = (d, at) => ({ at: at.toISOString(), followers: d.followers.map(slimU), following: d.following.map(slimU) });
  const ghost = (o) => ({ ...o, pic: '', is_private: false, is_verified: false, noPic: false });

  // Compare with the previous snapshot, verify each apparent "loss", update the record
  async function trackChanges(t, d, blocked) {
    const reliable = d.complete.following && d.complete.followers && !blocked && !S.ctrl.stopped;
    const rec = await dbGet(t.id);
    const now = new Date();
    if (!rec?.snapshot) {
      if (!reliable) { d.trackNote = 'The scan was incomplete, so no first snapshot was saved for this account.'; return; }
      d.changes = { first: true, items: [] };
      await dbPut({ id: t.id, username: t.username, pic: t.pic, isMe: t.isMe, scans: 1, snapshot: snapOf(d, now), events: [] });
      return;
    }
    const prev = rec.snapshot;
    const ch = { since: new Date(prev.at), items: [], reliable };
    for (const kind of ['followers', 'following']) {
      const cur = new Set(d[kind].map((u) => u.id));
      const old = new Map(prev[kind].map((u) => [u.id, u]));
      for (const u of d[kind]) {
        const o = old.get(u.id);
        if (!o) ch.items.push({ type: kind + '_new', u });
        else if (o.username && o.username !== u.username) ch.items.push({ type: 'rename', u, from: o.username });
      }
      const lost = prev[kind].filter((o) => !cur.has(o.id));
      const canVerify = reliable && lost.length > 0 && lost.length <= MAX_LOST_VERIFY;
      for (const o of lost) {
        let exists = null;
        if (canVerify) {
          S.scan.phase = 'Checking changes…'; updateScan();
          try {
            await wait(rand(settings.pageDelaySec * 600, settings.pageDelaySec * 1200) + rand(200, 600));
            exists = await relationExists(t, kind, o);
          } catch (e) { if (e instanceof StopSignal) break; }
        }
        if (exists === true) d[kind].push({ ...ghost(o), ord: 1e6 }); // Instagram skipped them — they are actually still there
        else ch.items.push({ type: kind + '_lost', u: ghost(o), verified: exists === false });
      }
    }
    d.changes = ch;
    if (!reliable) { d.trackNote = 'The scan was incomplete, so the snapshot was not updated; the changes below may not be exact.'; return; }
    rec.events = (rec.events || []).concat(ch.items.map((x) => ({ at: now.toISOString(), type: x.type, u: slimU(x.u), from: x.from, verified: x.verified }))).slice(-MAX_EVENTS);
    rec.snapshot = snapOf(d, now);
    Object.assign(rec, { username: t.username, pic: t.pic, isMe: t.isMe, scans: (rec.scans || 0) + 1 });
    await dbPut(rec);
  }

  async function startScan(username) {
    S.lastQuery = username;
    diag.length = 0;
    S.ctrl = { paused: false, stopped: false };
    S.scan = { phase: 'Looking up account…', following: 0, followers: 0, msg: '', verify: null };
    S.target = null;
    go('scan');
    let t;
    try {
      t = await resolveTarget(username);
    } catch (e) {
      go('start');
      toast(e.message, true);
      return;
    }
    S.target = t;
    const onFg = (n) => { S.scan.following = n; updateScan(); };
    const onFr = (n) => { S.scan.followers = n; updateScan(); };
    const phase = (p) => { S.scan.phase = p; updateScan(); };

    phase('Fetching following…');
    // Instagram accepts 200-item pages for the following list → usually a single request, no overlapping pages
    const fg = await fetchList('following', t.id, onFg, { count: 200 });
    let fr = { users: [], complete: false, error: null };
    if (!S.ctrl.stopped) {
      phase('Fetching followers…');
      fr = await fetchList('followers', t.id, onFr);
    }

    // Extra passes. Instagram can return overlapping pages: it repeats someone on two pages and never
    // returns someone else. Target = profile count; if unavailable, the raw record count of pass 1
    // (duplicates included — this matches the real count closely). Passes stop once the target is reached.
    const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789._'.split('');
    const passesFor = (kind) => [
      kind === 'following'
        ? { count: 12, surface: true, pass: 2, label: 'small pages' }
        : { count: 12, surface: true, pass: 2, label: 'small pages' },
      { count: 50, surface: true, order: 'date_followed_earliest', pass: 3, label: 'reverse order' },
      { count: 12, surface: true, offset: true, pass: 4, label: 'offset' },
      ...ALPHABET.map((ch) => ({ count: 50, surface: true, query: ch, pass: 5, label: `letter search "${ch}"` })),
    ];
    let blocked = null;
    for (const [kind, res, profileCount, cb, name] of [['following', fg, t.followingCount, onFg, 'following'], ['followers', fr, t.followerCount, onFr, 'followers']]) {
      const expected = Math.max(profileCount || 0, res.raw || 0);
      logDiag({ kind, expected, profileCount: profileCount ?? null, rawPass1: res.raw ?? null, uniquePass1: res.users.length });
      for (const o of passesFor(kind)) {
        if (blocked || S.ctrl.stopped || !res.complete || !expected || res.users.length >= expected) break;
        phase(`Searching for missing ${name} (${o.label}) — ${res.users.length}/${expected}`);
        const before = res.users.length;
        await wait(rand(settings.pageDelaySec * 1500, settings.pageDelaySec * 3000));
        const r = await fetchList(kind, t.id, cb, { ...o, expected }, res.users);
        res.users = r.users;
        if (r.error) {
          // Instagram says "slow down" — stop all extra searches instead of piling on more requests
          blocked = `Instagram temporarily throttled the extra searches; ${fmt(expected - res.users.length)} ${name} could not be looked up. Extra searches were stopped for safety — scan again in a few hours to complete.`;
          logDiag({ kind, pass: o.pass, circuitBreaker: true, error: r.error });
        }
        logDiag({ kind, pass: o.pass, label: o.label, summary: true, before, after: res.users.length, expected });
      }
    }

    const d = derive({
      following: fg.users, followers: fr.users, at: new Date(),
      complete: { following: fg.complete, followers: fr.complete },
      errors: [fg.error, fr.error].filter(Boolean),
      verified: new Set(), verifyNote: '', passNote: blocked || '',
    });

    // Step 3: verify everyone who appears as "not following back" (removes false positives)
    const doVerify = settings.verify === 'all' || (settings.verify !== 'off' && t.isMe);
    if (!S.ctrl.stopped && !blocked && doVerify) await verifyCandidates(t, d);
    else if (!doVerify) d.verifyNote = '';
    try { await trackChanges(t, d, blocked); } catch (e) { d.trackNote = 'Change tracking failed: ' + e.message; }
    S.data = derive(d);
    S.history = S.history.filter((x) => x.target.id !== t.id).concat({ target: t, data: S.data });
    S.tab = S.data.changes?.items?.length ? 'changes' : 'notBack'; S.page = 1; S.q = ''; S.selected.clear();
    go('results');
    toast(S.data.errors.length ? 'Scan partially completed — see the warning.' : 'Scan complete ✓', !!S.data.errors.length);
  }

  async function runUnfollow(users) {
    const csrf = getCookie('csrftoken');
    if (!csrf) { toast('csrftoken not found; reload the page and try again.', true); return; }
    S.ctrl = { paused: false, stopped: false };
    S.unf = { total: users.length, done: 0, ok: 0, fail: 0, log: [], msg: '', finished: false };
    go('unfollow');
    let consecutiveFail = 0;
    try {
      for (let i = 0; i < users.length; i++) {
        const u = users[i];
        await wait(0);
        let ok = false, why = '';
        try {
          const r = await fetch(`https://www.instagram.com/web/friendships/${u.id}/unfollow/`, {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrftoken': csrf, 'X-IG-App-ID': APP_ID, 'X-Requested-With': 'XMLHttpRequest' },
          });
          let j = null;
          try { j = await r.json(); } catch { /* ignore */ }
          ok = r.ok && (!j || j.status === 'ok');
          if (!ok) why = j?.feedback_title || j?.message || `HTTP ${r.status}`;
          if (!ok && (r.status === 429 || j?.spam || j?.feedback_required)) {
            S.unf.msg = `Instagram blocked the action (${why}). Stopped — wait a few hours.`;
            S.unf.log.push({ u, ok: false, why }); S.unf.fail++; S.unf.done++;
            break;
          }
        } catch (e) { why = 'Network error'; }

        S.unf.done++;
        S.unf.log.push({ u, ok, why });
        if (ok) {
          S.unf.ok++; consecutiveFail = 0;
          S.data.following = S.data.following.filter((x) => x.id !== u.id);
          derive(S.data);
          S.selected.delete(u.id);
        } else {
          S.unf.fail++;
          if (++consecutiveFail >= 3) { S.unf.msg = '3 errors in a row — stopped for safety.'; break; }
        }
        updateUnf();
        if (i === users.length - 1) break;

        await wait(rand(settings.unfollowDelaySec * 1000, settings.unfollowDelaySec * 1300));
        if (settings.unfollowBatch > 0 && S.unf.done % settings.unfollowBatch === 0) {
          const until = new Date(Date.now() + settings.unfollowBatchPauseMin * 60000);
          S.unf.msg = `Pausing to avoid a block — resuming at ${until.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`;
          updateUnf();
          await wait(settings.unfollowBatchPauseMin * 60000);
          S.unf.msg = '';
        }
      }
    } catch (e) {
      if (!(e instanceof StopSignal)) throw e;
      S.unf.msg = 'Stopped by you.';
    }
    S.unf.finished = true;
    if (!S.unf.msg) S.unf.msg = 'Done ✓';
    updateUnf();
  }

  /* ───────────────────────── Export ───────────────────────── */
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const slim = (u) => ({ id: u.id, username: u.username, full_name: u.full_name, is_private: u.is_private, is_verified: u.is_verified });
  function exportJSON() {
    const d = S.data;
    download(`${S.target.username}_follow-data_${today()}.json`, JSON.stringify({
      target: { id: S.target.id, username: S.target.username }, scannedAt: d.at.toISOString(), complete: d.complete,
      counts: { followers: d.followers.length, following: d.following.length, notFollowingBack: d.notBack.length, notFollowedBack: d.fans.length, mutual: d.mutual.length },
      notFollowingBack: d.notBack.map(slim), notFollowedBack: d.fans.map(slim), mutual: d.mutual.map(slim),
      followers: d.followers.map(slim), following: d.following.map(slim),
    }, null, 2), 'application/json');
  }
  function exportCSV() {
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['id', 'username', 'full_name', 'is_verified', 'is_private', 'profile_url'].join(',')]
      .concat(visible().map((u) => [u.id, u.username, u.full_name, u.is_verified, u.is_private, `https://www.instagram.com/${u.username}/`].map(q).join(',')));
    download(`${S.target.username}_${S.tab}_${today()}.csv`, '﻿' + rows.join('\n'), 'text/csv;charset=utf-8');
  }
  async function copyText(text, msg) {
    try { await navigator.clipboard.writeText(text); }
    catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
    toast(msg);
  }
  function copyDiag() {
    const t = S.target, d = S.data;
    const head = `IGTA diagnostics · ${new Date().toISOString()} · own account: ${t.isMe} · private: ${!!t.isPrivate}\n` +
      `profile: following ${t.followingCount} / followers ${t.followerCount} · list: following ${d.following.length} / followers ${d.followers.length}\n` +
      `complete: ${JSON.stringify(d.complete)} · errors: ${JSON.stringify(d.errors)}\n`;
    copyText(head + diag.map((x) => JSON.stringify(x)).join('\n'), 'Diagnostics report copied to clipboard');
  }
  async function copyNames() {
    const text = visible().map((u) => u.username).join('\n');
    try { await navigator.clipboard.writeText(text); }
    catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
    toast(`${visible().length} usernames copied to clipboard`);
  }
  function importWL(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const j = JSON.parse(rd.result);
        let n = 0;
        const add = (id, un) => { if (id) { whitelist.set(String(id), un || ''); n++; } };
        if (Array.isArray(j)) j.forEach((x) => add(x.id ?? x.pk, x.username));   // David's format included
        else Object.entries(j).forEach(([id, un]) => add(id, typeof un === 'string' ? un : un?.username));
        saveWL(); render(); toast(`${n} accounts added to the whitelist`);
      } catch { toast('Could not read the file (not valid JSON)', true); }
    };
    rd.readAsText(file);
  }

  /* ───────────────────────── UI ───────────────────────── */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}
  .app{width:min(980px,100%);height:min(92vh,900px);background:#111214;color:#e8e8ea;border:1px solid #2a2b30;border-radius:16px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);font-size:14px}
  .top{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #26272c;background:#16171a}
  .logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(45deg,#f58529,#dd2a7b,#8134af,#515bd4);display:grid;place-items:center;font-weight:800;color:#fff;font-size:13px}
  .title{font-weight:700;font-size:15px;flex:1}
  .body{flex:1;overflow:auto;padding:16px}
  button{cursor:pointer;border:1px solid #33343a;background:#1f2024;color:#e8e8ea;border-radius:9px;padding:8px 12px;font-size:13px;font-weight:600}
  button:hover:not(:disabled){background:#2a2b30}
  button:disabled{opacity:.45;cursor:not-allowed}
  button.pri{background:linear-gradient(45deg,#dd2a7b,#8134af);border:none;color:#fff}
  button.pri:hover:not(:disabled){filter:brightness(1.1)}
  button.dan{background:#b3261e;border:none;color:#fff}
  button.ghost{background:transparent;border-color:transparent}
  button.sm{padding:5px 9px;font-size:12px}
  .inp{width:100%;background:#0b0b0d;border:1px solid #33343a;color:#fff;border-radius:10px;padding:12px 14px;font-size:15px;outline:none}
  .inp:focus{border-color:#8134af}
  .card{background:#17181b;border:1px solid #26272c;border-radius:12px;padding:14px;margin-bottom:12px}
  .h2{font-weight:700;margin:0 0 8px;font-size:14px}
  .muted{color:#9a9ba3;font-size:12.5px;line-height:1.5}
  .row2{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
  .fld label{display:block;font-size:12px;color:#9a9ba3;margin-bottom:4px}
  .sel{width:100%;background:#0b0b0d;border:1px solid #33343a;color:#fff;border-radius:8px;padding:7px 9px;font-size:13px}
  .fld input{width:100%;background:#0b0b0d;border:1px solid #33343a;color:#fff;border-radius:8px;padding:7px 9px}
  .bar{height:8px;background:#26272c;border-radius:6px;overflow:hidden;margin:6px 0 2px}
  .bar>i{display:block;height:100%;background:linear-gradient(90deg,#f58529,#dd2a7b,#8134af);transition:width .3s}
  .stat{display:flex;justify-content:space-between;font-size:13px;margin-top:10px}
  .warn{background:#2b2210;border:1px solid #5c4513;color:#f3d38a;border-radius:10px;padding:10px 12px;font-size:12.5px;margin-bottom:10px;line-height:1.5}
  .info{background:#11202b;border:1px solid #1d3b52;color:#a8d4f5;border-radius:10px;padding:10px 12px;font-size:12.5px;margin-bottom:10px;line-height:1.5}
  .vok{background:#12291a;color:#7ddc8a}
  .tag.c-new{background:#12291a;color:#7ddc8a;font-weight:600}.tag.c-lost{background:#2b1212;color:#ff8a80;font-weight:600}.tag.c-ren{background:#11202b;color:#a8d4f5}
  .day{font-weight:700;margin:14px 0 6px;color:#c9cad0}
  .err{background:#2b1212;border-color:#6b1f1f;color:#ffb4ab}
  .tabs{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;margin-bottom:10px}
  .tab{white-space:nowrap;background:#17181b}
  .tab.on,.tab.on:hover:not(:disabled){background:#e8e8ea;color:#111;border-color:#e8e8ea}
  .cnt{opacity:.7;margin-left:6px;font-weight:500}
  .chip{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:#c9cad0;background:#17181b;border:1px solid #2a2b30;border-radius:999px;padding:5px 10px;cursor:pointer;user-select:none}
  .chip input{accent-color:#dd2a7b;margin:0}
  .list{border:1px solid #26272c;border-radius:12px;overflow:hidden}
  .item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #1f2024}
  .item:last-child{border-bottom:none}
  .item:hover{background:#17181b}
  .item.wl{background:#15170f}
  .item input[type=checkbox]{width:17px;height:17px;accent-color:#dd2a7b;flex:none}
  .av{width:40px;height:40px;border-radius:50%;object-fit:cover;background:#26272c;flex:none}
  .who{flex:1;min-width:0}
  .who a{color:#fff;text-decoration:none;font-weight:600}
  .who a:hover{text-decoration:underline}
  .fn{color:#9a9ba3;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tag{font-size:11px;padding:2px 7px;border-radius:999px;background:#26272c;color:#b9bac1;flex:none}
  .ver{color:#4aa3ff;margin-left:4px}
  .star{font-size:18px;line-height:1;padding:4px 8px;background:transparent;border-color:transparent;color:#6b6c73}
  .star.on{color:#f5c518}
  .selbar{position:sticky;bottom:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#16171a;border-top:1px solid #26272c;padding:10px 16px}
  .pager{display:flex;gap:8px;align-items:center;justify-content:center;margin:12px 0 4px}
  .empty{padding:40px;text-align:center;color:#9a9ba3}
  .head{display:flex;gap:12px;align-items:center;margin-bottom:12px}
  .head .av{width:52px;height:52px}
  .log{max-height:45vh;overflow:auto;font-size:13px}
  .log div{padding:4px 0;border-bottom:1px solid #1f2024}
  .ok{color:#7ddc8a}.no{color:#ff8a80}
  .toast{position:fixed;left:50%;top:20px;transform:translateX(-50%);z-index:2147483647;background:#e8e8ea;color:#111;padding:10px 16px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:90vw}
  .toast.bad{background:#ffb4ab}
  .fab{position:fixed;right:20px;bottom:20px;z-index:2147483646;width:52px;height:52px;border-radius:50%;border:none;background:linear-gradient(45deg,#f58529,#dd2a7b,#8134af);color:#fff;font-weight:800;box-shadow:0 8px 24px rgba(0,0,0,.4)}
  .modal{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.6);display:grid;place-items:center;padding:16px}
  .modal .card{max-width:440px;margin:0}
  @media (max-width:600px){.wrap{padding:0}.app{height:100vh;border-radius:0}.body{padding:12px}}
  `;

  const host = document.createElement('div');
  host.id = 'igta-host';
  const root = host.attachShadow({ mode: 'open' });
  root.append(h('style', {}, CSS));
  const fab = h('button', { class: 'fab', title: 'MVP Instagram Tracker', onclick: () => api.open(), style: 'display:none' }, 'IG');
  const bodyEl = h('div', { class: 'body' });
  const footEl = h('div');
  const titleEl = h('div', { class: 'title' }, 'MVP Instagram Tracker');
  const wrap = h('div', { class: 'wrap' },
    h('div', { class: 'app' },
      h('div', { class: 'top' }, h('div', { class: 'logo' }, 'IG'), titleEl,
        h('button', { class: 'ghost sm', title: 'Minimize', onclick: () => api.hide() }, '▁'),
        h('button', { class: 'ghost sm', title: 'Close', onclick: () => api.close() }, '✕')),
      bodyEl, footEl));
  root.append(wrap, fab);
  document.body.append(host);

  // Keep Instagram's keyboard shortcuts (n = notifications, / = search, …) from catching what you type in the panel.
  // Key events are stopped before they leave the panel; our own keys (Enter, Esc) are handled here.
  const KEY_EVENTS = ['keydown', 'keypress', 'keyup'];
  const keyGuard = (e) => {
    const path = e.composedPath();
    if (!path.includes(host)) return;
    e.stopImmediatePropagation();
    if (e.type === 'keydown' && e.key === 'Enter' && typeof path[0].__onEnter === 'function') { e.preventDefault(); path[0].__onEnter(); }
    if (e.type === 'keydown' && e.key === 'Escape') root.querySelectorAll('.modal').forEach((m) => m.remove());
  };
  KEY_EVENTS.forEach((t) => { window.addEventListener(t, keyGuard, true); host.addEventListener(t, (e) => e.stopPropagation()); });

  let toastTimer;
  function toast(text, bad) {
    root.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, text);
    root.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), bad ? 6000 : 3000);
  }
  function confirmBox(text, yesLabel, onYes) {
    const m = h('div', { class: 'modal' },
      h('div', { class: 'card' }, h('p', { class: 'h2' }, 'Are you sure?'), h('p', { class: 'muted', style: 'margin:0 0 14px' }, text),
        h('div', { class: 'row2', style: 'justify-content:flex-end' },
          h('button', { onclick: () => m.remove() }, 'Cancel'),
          h('button', { class: 'dan', onclick: () => { m.remove(); onYes(); } }, yesLabel))));
    root.append(m);
  }

  function go(screen) { S.screen = screen; render(); }
  function render() {
    bodyEl.replaceChildren();
    footEl.replaceChildren();
    ({ start: renderStart, scan: renderScan, results: renderResults, unfollow: renderUnfollow, compare: renderCompare, history: renderHistory })[S.screen]();
  }

  /* ── Start ── */
  function renderStart() {
    titleEl.textContent = 'MVP Instagram Tracker';
    const input = h('input', { class: 'inp', placeholder: 'username  (leave empty = your own account)', value: S.lastQuery, autocomplete: 'off', spellcheck: false });
    const start = () => startScan(input.value.trim().replace(/^@/, '').replace(/.*instagram\.com\//, '').replace(/[/?].*$/, ''));
    input.__onEnter = start;

    const fields = [
      ['pageDelaySec', 'Scan: delay between pages (s)'], ['longPauseEvery', 'Scan: pause every N pages'], ['longPauseSec', 'Scan: pause length (s)'],
      ['unfollowDelaySec', 'Unfollow: delay between (s)'], ['unfollowBatch', 'Unfollow: pause every N actions'], ['unfollowBatchPauseMin', 'Unfollow: pause length (min)'],
    ];
    const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: (e) => e.target.files[0] && importWL(e.target.files[0]) });

    bodyEl.append(
      h('div', { class: 'card' },
        h('p', { class: 'h2' }, 'Which account should we scan?'),
        h('div', { class: 'row2', style: 'flex-wrap:nowrap' }, input, h('button', { class: 'pri', style: 'padding:12px 20px', onclick: start }, 'Scan')),
        h('p', { class: 'muted', style: 'margin:10px 0 0' },
          'Leave empty for your own account — unfollowing is only available there. Other accounts: public ones, or private ones you follow. You can paste a username or a profile link.')),
      h('details', { class: 'card' },
        h('summary', { class: 'h2', style: 'cursor:pointer;margin:0' }, '⚙️ Settings'),
        h('p', { class: 'muted' }, 'Lower values scan faster but increase the risk of a temporary block.'),
        h('div', { class: 'grid' }, fields.map(([k, label]) => h('div', { class: 'fld' }, h('label', {}, label),
          h('input', { type: 'number', min: 0, step: 'any', value: settings[k], onchange: (e) => { settings[k] = Math.max(0, Number(e.target.value) || 0); store.set(K_SETTINGS, settings); } })))),
        h('div', { class: 'fld', style: 'margin-top:12px' }, h('label', {}, 'Result verification (checks each "not following back" entry one by one)'),
          h('select', { class: 'sel', onchange: (e) => { settings.verify = e.target.value; store.set(K_SETTINGS, settings); } },
            [['me', 'My account only (recommended)'], ['all', 'All accounts (slower)'], ['off', 'Off']].map(([v, l]) => h('option', { value: v, selected: settings.verify === v }, l)))),
        h('div', { class: 'row2', style: 'margin-top:10px' }, h('button', { class: 'sm', onclick: () => { settings = { ...DEFAULTS }; store.set(K_SETTINGS, settings); render(); } }, 'Reset to defaults'))),
      h('div', { class: 'card' },
        h('p', { class: 'h2' }, `★ Whitelist — ${whitelist.size} accounts`),
        h('p', { class: 'muted', style: 'margin-top:0' }, 'Starred accounts are never selected for unfollowing. Stored in this browser.'),
        h('div', { class: 'row2' },
          h('button', { class: 'sm', disabled: !whitelist.size, onclick: () => download(`whitelist_${today()}.json`, JSON.stringify(Object.fromEntries(whitelist), null, 2), 'application/json') }, 'Export'),
          h('button', { class: 'sm', onclick: () => fileIn.click() }, 'Import'), fileIn,
          h('button', { class: 'sm', disabled: !whitelist.size, onclick: () => confirmBox('Everyone on the whitelist will be removed.', 'Clear', () => { whitelist.clear(); saveWL(); render(); }) }, 'Clear'))),
      historyCard(),
      savedCard(),
      h('p', { class: 'muted' }, '⚠️ This tool uses Instagram\'s unofficial internal API, which is against Instagram\'s terms. Scanning too often or bulk unfollowing can get your account temporarily restricted.'),
    );
    setTimeout(() => input.focus(), 0);
  }

  /* ── Scan ── */
  let scanRefs = null;
  function renderScan() {
    titleEl.textContent = 'Scanning…';
    const r = scanRefs = {
      head: h('div', { class: 'head' }), phase: h('p', { class: 'h2' }), msg: h('div', { class: 'muted', style: 'min-height:20px;margin-top:10px' }),
      fgT: h('span'), frT: h('span'), fgB: h('i'), frB: h('i'), vT: h('span'), vB: h('i'), vBox: h('div', { style: 'display:none' }),
      pause: h('button', { onclick: () => { S.ctrl.paused = !S.ctrl.paused; updateScan(); } }),
    };
    bodyEl.append(h('div', { class: 'card' }, r.head, r.phase,
      h('div', { class: 'stat' }, h('span', {}, 'Following'), r.fgT), h('div', { class: 'bar' }, r.fgB),
      h('div', { class: 'stat' }, h('span', {}, 'Followers'), r.frT), h('div', { class: 'bar' }, r.frB),
      r.vBox,
      r.msg,
      h('div', { class: 'row2', style: 'margin-top:14px' }, r.pause,
        h('button', { class: 'dan', onclick: () => { S.ctrl.stopped = true; S.ctrl.paused = false; } }, 'Stop and show results'))),
      h('p', { class: 'muted' }, 'Keep this tab open. Large accounts can take a few minutes; the pauses are intentional.'));
    updateScan();
  }
  function updateScan() {
    if (S.screen !== 'scan' || !scanRefs) return;
    const r = scanRefs, t = S.target, s = S.scan;
    r.head.replaceChildren(...(t ? [t.pic ? h('img', { class: 'av', src: t.pic }) : '', h('div', {}, h('div', { style: 'font-weight:700' }, '@' + t.username, t.isMe ? ' (you)' : ''), h('div', { class: 'fn' }, t.full_name))] : []));
    r.phase.textContent = S.ctrl.paused ? '⏸ Paused' : s.phase;
    const pct = (n, tot) => (tot ? Math.min(100, (n / tot) * 100) : n ? 50 : 0);
    r.fgT.textContent = `${fmt(s.following)} / ${fmt(t?.followingCount)}`;
    r.frT.textContent = `${fmt(s.followers)} / ${fmt(t?.followerCount)}`;
    r.fgB.style.width = pct(s.following, t?.followingCount) + '%';
    r.frB.style.width = pct(s.followers, t?.followerCount) + '%';
    r.msg.textContent = s.msg;
    if (s.verify) {
      if (!r.vBox.firstChild) r.vBox.append(h('div', { class: 'stat' }, h('span', {}, 'Verification'), r.vT), h('div', { class: 'bar' }, r.vB));
      r.vBox.style.display = '';
      r.vT.textContent = `${fmt(s.verify.done)} / ${fmt(s.verify.total)}` + (s.verify.fixed ? `  ·  ${s.verify.fixed} fixed` : '');
      r.vB.style.width = (s.verify.done / s.verify.total) * 100 + '%';
    }
    r.pause.textContent = S.ctrl.paused ? '▶ Resume' : '⏸ Pause';
  }

  /* ── Results ── */
  const TABS = () => {
    const me = S.target.isMe;
    return [
      ['notBack', me ? "Don't follow you back" : "Don't follow them back"],
      ['fans', me ? "You don't follow back" : "They don't follow back"],
      ['mutual', 'Mutual'], ['following', 'Following'], ['followers', 'Followers'],
    ].concat(S.data.changes && !S.data.changes.first ? [['changes', 'Changes']] : []);
  };
  const canSelect = () => S.target.isMe && ['notBack', 'following', 'mutual'].includes(S.tab);
  const CHG = {
    followers_new: ['＋ new follower', 'c-new'], followers_lost: ['− unfollowed', 'c-lost'],
    following_new: ['＋ started following', 'c-new'], following_lost: ['− stopped following', 'c-lost'], rename: ['↻ renamed', 'c-ren'],
  };
  const CHG_ORDER = ['followers_new', 'followers_lost', 'following_new', 'following_lost', 'rename'];
  const listOf = (k) => (k === 'changes' ? (S.data.changes?.items || []).map((x) => ({ ...x.u, chg: x })) : S.data[k]);
  function visible() {
    const q = S.q.toLowerCase(), f = S.f;
    const byName = (a, b) => a.username.localeCompare(b.username);
    const sorter = S.tab === 'changes' ? (a, b) => CHG_ORDER.indexOf(a.chg.type) - CHG_ORDER.indexOf(b.chg.type) || byName(a, b)
      : S.sort === 'ig' ? (a, b) => (a.ord ?? 1e9) - (b.ord ?? 1e9) : byName;
    return listOf(S.tab).filter((u) =>
      (!f.hideVerified || !u.is_verified) && (!f.hidePrivate || !u.is_private) && (!f.onlyNoPic || u.noPic) &&
      (!f.hideWhitelisted || !whitelist.has(u.id)) &&
      (!q || u.username.toLowerCase().includes(q) || u.full_name.toLowerCase().includes(q)),
    ).sort(sorter);
  }

  let res = null;
  function renderResults() {
    const d = S.data, t = S.target;
    titleEl.textContent = `@${t.username} — results`;
    const warns = [];
    if (!d.complete.followers) warns.push('Followers list is incomplete: the "don\'t follow back" list may include people who actually follow you. Be careful before unfollowing.');
    if (!d.complete.following) warns.push('Following list is incomplete.');
    if (d.passNote) warns.push(d.passNote);
    if (d.trackNote) warns.push(d.trackNote);
    if (d.verifyNote) warns.push(d.verifyNote);
    const infos = [];
    if (d.fixedCount) infos.push(`Verification found and fixed ${d.fixedCount} accounts Instagram had skipped in the list.`);
    const diffs = [];
    if (t.followerCount != null && t.followerCount !== d.followers.length) diffs.push(`followers ${fmt(t.followerCount)} → ${fmt(d.followers.length)} in list`);
    if (t.followingCount != null && t.followingCount !== d.following.length) diffs.push(`following ${fmt(t.followingCount)} → ${fmt(d.following.length)} in list`);
    const c = d.changes;
    if (c?.first) infos.push('First snapshot saved for this account. From the next scan on, the "Changes" tab shows who came and who left.');
    else if (c) {
      const n = (ty) => c.items.filter((x) => x.type === ty).length;
      const when = c.since.toLocaleString('en-GB', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
      infos.push(c.items.length
        ? `Since the last scan (${when}): followers +${n('followers_new')} / −${n('followers_lost')}, following +${n('following_new')} / −${n('following_lost')}${n('rename') ? `, ${n('rename')} renamed` : ''}.`
        : `No changes since the last scan (${when}).`);
    }
    if (diffs.length) infos.push(`Differs from the profile count (${diffs.join(', ')}). Instagram counts deactivated or restricted accounts but doesn't list them; a small difference is normal.`);

    res = { tabs: h('div', { class: 'tabs' }), list: h('div'), pager: h('div', { class: 'pager' }), sel: h('div', { class: 'selbar' }) };
    const search = h('input', { class: 'inp', style: 'padding:9px 12px;font-size:14px', placeholder: 'Search: username or name', value: S.q,
      oninput: (e) => { S.q = e.target.value; S.page = 1; updateList(); } });
    const chip = (key, label) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: S.f[key], onchange: (e) => { S.f[key] = e.target.checked; S.page = 1; updateList(); } }), label);

    bodyEl.append(...[
      h('div', { class: 'head' }, t.pic ? h('img', { class: 'av', src: t.pic }) : '',
        h('div', { style: 'flex:1' }, h('div', { style: 'font-weight:700;font-size:16px' }, '@' + t.username, t.isMe ? ' (you)' : ''),
          h('div', { class: 'muted' }, `${fmt(d.followers.length)} followers · ${fmt(d.following.length)} following · ${d.at.toLocaleString('en-GB')}`)),
        d.changes ? h('button', { class: 'sm', style: 'margin-right:6px', onclick: () => openHistory(t.id) }, '🕘 History') : '',
        S.history.length >= 2 ? h('button', { class: 'sm', style: 'margin-right:6px', onclick: () => openCompare() }, '⇄ Compare') : '',
        h('button', { class: 'sm', onclick: () => go('start') }, '↺ New scan')),
      warns.map((w) => h('div', { class: 'warn' }, '⚠️ ' + w)),
      infos.map((w) => h('div', { class: 'info' }, 'ℹ️ ' + w)),
      d.errors.map((e) => h('div', { class: 'warn err' }, e)),
      res.tabs,
      h('div', { class: 'row2', style: 'margin-bottom:10px;flex-wrap:nowrap' }, search,
        h('button', { class: 'sm', title: 'Download the visible list as CSV', onclick: exportCSV }, 'CSV'),
        h('button', { class: 'sm', title: 'Download all lists as JSON', onclick: exportJSON }, 'JSON'),
        h('button', { class: 'sm', title: 'Copy the visible usernames', onclick: copyNames }, 'Copy'),
        h('button', { class: 'sm', title: 'Technical report for troubleshooting (no usernames)', onclick: copyDiag }, 'Diagnostics')),
      h('div', { class: 'row2', style: 'margin-bottom:12px' },
        h('select', { class: 'sel', style: 'width:auto;border-radius:999px;padding:5px 10px', title: 'Sort',
          onchange: (e) => { S.sort = e.target.value; S.page = 1; updateList(); } },
          h('option', { value: 'az', selected: S.sort === 'az' }, 'Sort: A → Z'),
          h('option', { value: 'ig', selected: S.sort === 'ig' }, 'Sort: Instagram order (usually newest first)')),
        chip('hideWhitelisted', '★ Hide whitelisted'), chip('hideVerified', 'Hide verified'), chip('hidePrivate', 'Hide private'), chip('onlyNoPic', 'No profile picture only (bots?)')),
      res.list, res.pager,
    ].flat());
    footEl.append(res.sel);
    updateList();
  }

  function updateList() {
    if (S.screen !== 'results' || !res) return;
    const d = S.data;
    res.tabs.replaceChildren(...TABS().map(([k, label]) => h('button', { class: 'tab' + (S.tab === k ? ' on' : ''), onclick: () => { S.tab = k; S.page = 1; updateList(); } },
      label, h('span', { class: 'cnt' }, fmt(listOf(k).length)))));

    const all = visible();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    S.page = Math.min(S.page, pages);
    const slice = all.slice((S.page - 1) * PAGE_SIZE, S.page * PAGE_SIZE);
    const sel = canSelect();

    res.list.replaceChildren(slice.length ? h('div', { class: 'list' }, slice.map((u) => {
      const wl = whitelist.has(u.id);
      return h('div', { class: 'item' + (wl ? ' wl' : '') },
        sel ? h('input', { type: 'checkbox', checked: S.selected.has(u.id), disabled: wl, title: wl ? 'On whitelist' : '',
          onchange: (e) => { e.target.checked ? S.selected.add(u.id) : S.selected.delete(u.id); updateSel(); } }) : '',
        miniAv(u.pic),
        h('div', { class: 'who' },
          h('a', { href: `https://www.instagram.com/${encodeURIComponent(u.username)}/`, target: '_blank', rel: 'noopener' }, u.username),
          u.is_verified ? h('span', { class: 'ver', title: 'Verified' }, '✔') : '',
          h('div', { class: 'fn' }, u.full_name || ' ')),
        u.is_private ? h('span', { class: 'tag' }, 'Private') : '',
        u.noPic ? h('span', { class: 'tag' }, 'No photo') : '',
        u.chg ? h('span', { class: 'tag ' + CHG[u.chg.type][1], title: u.chg.verified ? 'Checked individually' : '' },
          CHG[u.chg.type][0] + (u.chg.from ? ` (was @${u.chg.from})` : '') + (u.chg.verified ? ' ✓' : '')) : '',
        (S.tab === 'notBack' || S.tab === 'fans') && S.data.verified.has(u.id) ? h('span', { class: 'tag vok', title: 'Checked individually' }, '✓ verified') : '',
        h('button', { class: 'star' + (wl ? ' on' : ''), title: wl ? 'Remove from whitelist' : 'Add to whitelist (protect)',
          onclick: () => { if (wl) whitelist.delete(u.id); else { whitelist.set(u.id, u.username); S.selected.delete(u.id); } saveWL(); updateList(); } }, wl ? '★' : '☆'));
    })) : h('div', { class: 'empty' }, S.q || S.f.hideVerified || S.f.hidePrivate || S.f.onlyNoPic ? 'Nobody matches the filter.' : 'Nobody in this list 🎉'));

    res.pager.replaceChildren(...(pages > 1 ? [
      h('button', { class: 'sm', disabled: S.page <= 1, onclick: () => { S.page--; updateList(); bodyEl.scrollTop = 0; } }, '‹ Previous'),
      h('span', { class: 'muted' }, `${S.page} / ${pages}  ·  ${fmt(all.length)} accounts`),
      h('button', { class: 'sm', disabled: S.page >= pages, onclick: () => { S.page++; updateList(); bodyEl.scrollTop = 0; } }, 'Next ›'),
    ] : [h('span', { class: 'muted' }, `${fmt(all.length)} accounts`)]));
    updateSel(slice, all);
  }

  function updateSel(slice, all) {
    if (!res) return;
    if (!S.target.isMe) {
      res.sel.replaceChildren(h('span', { class: 'muted' }, 'You are viewing another account — read-only mode.'));
      return;
    }
    if (!canSelect()) {
      res.sel.replaceChildren(h('span', { class: 'muted' }, 'To unfollow, switch to the "Don\'t follow you back", "Mutual" or "Following" tab.'));
      return;
    }
    slice = slice || visible().slice((S.page - 1) * PAGE_SIZE, S.page * PAGE_SIZE);
    all = all || visible();
    const pick = (arr) => { arr.forEach((u) => { if (!whitelist.has(u.id)) S.selected.add(u.id); }); updateList(); };
    const n = S.selected.size;
    res.sel.replaceChildren(
      h('button', { class: 'sm', onclick: () => pick(slice) }, 'Select page'),
      h('button', { class: 'sm', onclick: () => pick(all) }, `Select all (${fmt(all.filter((u) => !whitelist.has(u.id)).length)})`),
      h('button', { class: 'sm', disabled: !n, onclick: () => { S.selected.clear(); updateList(); } }, 'Clear'),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'dan', disabled: !n, onclick: () => {
        const byId = new Map(S.data.following.map((u) => [u.id, u]));
        const users = [...S.selected].map((id) => byId.get(id)).filter((u) => u && !whitelist.has(u.id));
        const mins = Math.round((users.length * settings.unfollowDelaySec + Math.floor(users.length / Math.max(1, settings.unfollowBatch)) * settings.unfollowBatchPauseMin * 60) / 60);
        confirmBox(`${users.length} accounts will be unfollowed. Estimated time ~${mins} min. This cannot be undone.` +
          (!S.data.complete.followers ? ' WARNING: the followers list is incomplete; some of the selected accounts may follow you.' : ''),
        'Unfollow', () => runUnfollow(users));
      } }, `Unfollow (${fmt(n)})`),
    );
  }

  /* ── Session scans & comparison ── */
  const miniAv = (pic) => (pic ? h('img', { class: 'av', src: pic, loading: 'lazy', alt: '' }) : h('div', { class: 'av' }));
  function historyCard() {
    if (!S.history.length) return '';
    return h('div', { class: 'card' },
      h('p', { class: 'h2' }, `Scans in this session — ${S.history.length}`),
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Open them without rescanning, or compare accounts. Cleared when the page reloads.'),
      h('div', { class: 'list' }, S.history.map((x) => h('div', { class: 'item' }, miniAv(x.target.pic),
        h('div', { class: 'who' }, h('b', {}, '@' + x.target.username, x.target.isMe ? ' (you)' : ''),
          h('div', { class: 'fn' }, `${fmt(x.data.followers.length)} followers · ${fmt(x.data.following.length)} following · ${x.data.at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`)),
        h('button', { class: 'sm', onclick: () => { S.target = x.target; S.data = x.data; S.tab = 'notBack'; S.page = 1; S.q = ''; S.selected.clear(); go('results'); } }, 'Open')))),
      S.history.length >= 2 ? h('div', { class: 'row2', style: 'margin-top:10px' }, h('button', { class: 'pri', onclick: () => openCompare() }, '⇄ Compare accounts')) : '');
  }

  function openCompare() {
    const ids = S.history.map((x) => x.target.id);
    S.cmp.ids = new Set([...S.cmp.ids].filter((id) => ids.includes(id)));
    if (S.cmp.ids.size < 2) S.cmp.ids = new Set(ids.slice(-Math.min(5, ids.length)));
    go('compare');
  }

  function compareResult() {
    const scans = S.history.filter((x) => S.cmp.ids.has(x.target.id));
    const key = S.cmp.mode; // followers | following
    if (scans.length < 2) return { scans, users: [] };
    const [first, ...rest] = scans;
    const sets = rest.map((x) => new Set(x.data[key].map((u) => u.id)));
    const users = first.data[key].filter((u) => sets.every((st) => st.has(u.id)));
    return { scans, users };
  }

  let cmpRefs = null;
  function renderCompare() {
    titleEl.textContent = 'Compare accounts';
    cmpRefs = { list: h('div'), sum: h('p', { class: 'h2', style: 'margin:0 0 10px' }) };
    const modeBtn = (m, label) => h('button', { class: 'tab' + (S.cmp.mode === m ? ' on' : ''), onclick: () => { S.cmp.mode = m; render(); } }, label);
    bodyEl.append(
      h('div', { class: 'row2', style: 'margin-bottom:12px' }, h('button', { class: 'sm', onclick: () => go(S.data ? 'results' : 'start') }, '‹ Back'),
        h('span', { class: 'muted' }, 'Select 2 to 5 accounts.')),
      h('div', { class: 'list', style: 'margin-bottom:12px' }, S.history.map((x) => {
        const on = S.cmp.ids.has(x.target.id);
        return h('label', { class: 'item', style: 'cursor:pointer' },
          h('input', { type: 'checkbox', checked: on, disabled: !on && S.cmp.ids.size >= 5,
            onchange: (e) => { e.target.checked ? S.cmp.ids.add(x.target.id) : S.cmp.ids.delete(x.target.id); render(); } }),
          miniAv(x.target.pic),
          h('div', { class: 'who' }, h('b', {}, '@' + x.target.username), h('div', { class: 'fn' }, `${fmt(x.data.followers.length)} followers · ${fmt(x.data.following.length)} following`)));
      })),
      h('div', { class: 'tabs' }, modeBtn('followers', 'Common followers'), modeBtn('following', 'Common following')),
      h('div', { class: 'row2', style: 'margin-bottom:10px;flex-wrap:nowrap' },
        h('input', { class: 'inp', style: 'padding:9px 12px;font-size:14px', placeholder: 'Search', value: S.cmp.q, oninput: (e) => { S.cmp.q = e.target.value; updateCompare(); } }),
        h('button', { class: 'sm', onclick: () => cmpExport('csv') }, 'CSV'),
        h('button', { class: 'sm', onclick: () => cmpExport('copy') }, 'Copy')),
      cmpRefs.sum, cmpRefs.list);
    updateCompare();
  }
  function cmpVisible() {
    const { scans, users } = compareResult();
    const q = S.cmp.q.toLowerCase();
    return { scans, users: users.filter((u) => !q || u.username.toLowerCase().includes(q) || u.full_name.toLowerCase().includes(q)).sort((a, b) => a.username.localeCompare(b.username)) };
  }
  function updateCompare() {
    if (S.screen !== 'compare' || !cmpRefs) return;
    const { scans, users } = cmpVisible();
    const what = S.cmp.mode === 'followers' ? 'common followers' : 'common following';
    cmpRefs.sum.textContent = scans.length < 2 ? 'Select at least 2 accounts to compare.' : `${scans.map((x) => '@' + x.target.username).join(' + ')} → ${fmt(users.length)} ${what}`;
    const shown = users.slice(0, 500);
    cmpRefs.list.replaceChildren(scans.length < 2 ? '' : shown.length ? h('div', { class: 'list' }, shown.map((u) => h('div', { class: 'item' }, miniAv(u.pic),
      h('div', { class: 'who' }, h('a', { href: `https://www.instagram.com/${encodeURIComponent(u.username)}/`, target: '_blank', rel: 'noopener' }, u.username),
        u.is_verified ? h('span', { class: 'ver' }, '✔') : '', h('div', { class: 'fn' }, u.full_name || ' ')),
      u.is_private ? h('span', { class: 'tag' }, 'Private') : ''))) : h('div', { class: 'empty' }, 'Nobody in common.'),
    users.length > 500 ? h('p', { class: 'muted' }, `Showing the first 500; download the CSV for all.`) : '');
  }
  function cmpExport(kind) {
    const { scans, users } = cmpVisible();
    if (scans.length < 2) return;
    if (kind === 'copy') return copyText(users.map((u) => u.username).join('\n'), `${users.length} usernames copied`);
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['id', 'username', 'full_name', 'is_verified', 'is_private', 'profile_url'].join(',')]
      .concat(users.map((u) => [u.id, u.username, u.full_name, u.is_verified, u.is_private, `https://www.instagram.com/${u.username}/`].map(q).join(',')));
    download(`common_${S.cmp.mode}_${scans.map((x) => x.target.username).join('_')}_${today()}.csv`, '﻿' + rows.join('\n'), 'text/csv;charset=utf-8');
  }

  /* ── Saved accounts & change history ── */
  function savedCard() {
    const box = h('div', { class: 'card' }, h('p', { class: 'h2' }, '🕘 Saved accounts'), h('p', { class: 'muted', style: 'margin:0' }, 'Loading…'));
    dbAll().then((recs) => {
      recs.sort((a, b) => (b.snapshot?.at || '').localeCompare(a.snapshot?.at || ''));
      const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: (e) => e.target.files[0] && importDB(e.target.files[0]) });
      box.replaceChildren(
        h('p', { class: 'h2' }, `🕘 Saved accounts — ${recs.length}`),
        h('p', { class: 'muted', style: 'margin-top:0' }, 'Every complete scan is stored in this browser; when you scan the same account again you see who came and who left. Nothing is sent anywhere.'),
        recs.length ? h('div', { class: 'list', style: 'margin-bottom:10px' }, recs.map((r) => h('div', { class: 'item' }, miniAv(r.pic),
          h('div', { class: 'who' }, h('b', {}, '@' + r.username, r.isMe ? ' (you)' : ''),
            h('div', { class: 'fn' }, `last scan ${new Date(r.snapshot.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${r.scans || 1} scans · ${(r.events || []).length} changes`)),
          h('button', { class: 'sm', onclick: () => startScan(r.isMe ? '' : r.username) }, 'Scan'),
          h('button', { class: 'sm', onclick: () => openHistory(r.id) }, 'History'),
          h('button', { class: 'sm ghost', title: 'Delete record', onclick: () => confirmBox(`All saved data and history for @${r.username} will be deleted.`, 'Delete', async () => { await dbDel(r.id); render(); }) }, '🗑')))) : '',
        h('div', { class: 'row2' },
          h('button', { class: 'sm', disabled: !recs.length, onclick: () => download(`igta_backup_${today()}.json`, JSON.stringify({ igta: 1, exportedAt: new Date().toISOString(), accounts: recs }), 'application/json') }, 'Back up'),
          h('button', { class: 'sm', onclick: () => fileIn.click() }, 'Restore backup'), fileIn));
    }).catch(() => box.replaceChildren(h('p', { class: 'h2' }, '🕘 Saved accounts'), h('p', { class: 'muted' }, 'Browser storage is not available (private window?). Change tracking will not work.')));
    return box;
  }

  function importDB(file) {
    const rd = new FileReader();
    rd.onload = async () => {
      try {
        const j = JSON.parse(rd.result);
        if (!Array.isArray(j.accounts)) throw new Error();
        let n = 0;
        for (const r of j.accounts) {
          if (!r?.id || !r.snapshot) continue;
          const cur = await dbGet(r.id);
          if (!cur) { await dbPut(r); n++; continue; }
          const key = (e) => `${e.at}|${e.type}|${e.u?.id}`;
          const seenE = new Set((cur.events || []).map(key));
          cur.events = (cur.events || []).concat((r.events || []).filter((e) => !seenE.has(key(e)))).sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_EVENTS);
          if (r.snapshot.at > cur.snapshot.at) cur.snapshot = r.snapshot;
          cur.scans = Math.max(cur.scans || 1, r.scans || 1);
          await dbPut(cur); n++;
        }
        toast(`Restored records for ${n} accounts`); render();
      } catch { toast('Could not read the backup file', true); }
    };
    rd.readAsText(file);
  }

  let histRec = null;
  function openHistory(id) { S.histId = id; S.histFilter = 'all'; histRec = null; go('history'); }
  function renderHistory() {
    titleEl.textContent = 'Change history';
    const back = h('button', { class: 'sm', onclick: () => go(S.data && S.target?.id === S.histId ? 'results' : 'start') }, '‹ Back');
    const listBox = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
    bodyEl.append(h('div', { class: 'row2', style: 'margin-bottom:12px' }, back), listBox);
    const draw = () => {
      const r = histRec;
      if (!r) { listBox.replaceChildren(h('p', { class: 'muted' }, 'No record for this account.')); return; }
      const ev = (r.events || []).filter((e) => S.histFilter === 'all' || e.type.startsWith(S.histFilter)).slice().reverse();
      const days = new Map();
      for (const e of ev) {
        const k = new Date(e.at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        if (!days.has(k)) days.set(k, []);
        days.get(k).push(e);
      }
      const fbtn = (v, l) => h('button', { class: 'tab' + (S.histFilter === v ? ' on' : ''), onclick: () => { S.histFilter = v; draw(); } }, l);
      listBox.replaceChildren(...[
        h('div', { class: 'head' }, miniAv(r.pic), h('div', {}, h('div', { style: 'font-weight:700;font-size:16px' }, '@' + r.username),
          h('div', { class: 'muted' }, `${r.scans || 1} scans · last: ${new Date(r.snapshot.at).toLocaleString('en-GB')} · now ${fmt(r.snapshot.followers.length)} followers / ${fmt(r.snapshot.following.length)} following`))),
        h('div', { class: 'tabs' }, fbtn('all', 'All'), fbtn('followers', 'Follower changes'), fbtn('following', 'Following changes'), fbtn('rename', 'Renames')),
        ev.length ? [...days].map(([day, es]) => [h('div', { class: 'day' }, day),
          h('div', { class: 'list' }, es.map((e) => h('div', { class: 'item' },
            h('span', { class: 'muted', style: 'width:44px;flex:none' }, new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })),
            h('div', { class: 'who' }, h('a', { href: `https://www.instagram.com/${encodeURIComponent(e.u.username)}/`, target: '_blank', rel: 'noopener' }, e.u.username),
              h('div', { class: 'fn' }, e.u.full_name || ' ')),
            h('span', { class: 'tag ' + CHG[e.type][1] }, CHG[e.type][0] + (e.from ? ` (was @${e.from})` : '') + (e.verified ? ' ✓' : '')))))]).flat()
          : h('div', { class: 'empty' }, (r.events || []).length ? 'No changes for this filter.' : 'No changes recorded yet. They will appear here after you scan the account again later.'),
      ].flat(2));
    };
    if (histRec?.id === S.histId) draw();
    else dbGet(S.histId).then((r) => { histRec = r || null; if (S.screen === 'history') draw(); }).catch(() => listBox.replaceChildren(h('p', { class: 'muted' }, 'Browser storage is not available.')));
  }

  /* ── Unfollow ── */
  let unfRefs = null;
  function renderUnfollow() {
    titleEl.textContent = 'Unfollowing…';
    const r = unfRefs = {
      t: h('p', { class: 'h2' }), b: h('i'), msg: h('div', { class: 'muted', style: 'min-height:20px;margin:8px 0' }), log: h('div', { class: 'log' }),
      pause: h('button', { onclick: () => { S.ctrl.paused = !S.ctrl.paused; updateUnf(); } }),
      stop: h('button', { class: 'dan', onclick: () => { S.ctrl.stopped = true; S.ctrl.paused = false; } }, 'Stop'),
      back: h('button', { class: 'pri', onclick: () => go('results') }, 'Back to results'),
    };
    bodyEl.append(h('div', { class: 'card' }, r.t, h('div', { class: 'bar' }, r.b), r.msg, h('div', { class: 'row2' }, r.pause, r.stop, r.back)),
      h('div', { class: 'card' }, h('p', { class: 'h2' }, 'Log'), r.log));
    updateUnf();
  }
  function updateUnf() {
    if (S.screen !== 'unfollow' || !unfRefs) return;
    const r = unfRefs, u = S.unf;
    r.t.textContent = `${u.done} / ${u.total}  ·  ✓ ${u.ok}  ✗ ${u.fail}` + (S.ctrl.paused ? '  ·  ⏸ paused' : '');
    r.b.style.width = (u.total ? (u.done / u.total) * 100 : 0) + '%';
    r.msg.textContent = u.msg;
    r.pause.textContent = S.ctrl.paused ? '▶ Resume' : '⏸ Pause';
    r.pause.style.display = r.stop.style.display = u.finished ? 'none' : '';
    r.back.style.display = u.finished ? '' : 'none';
    titleEl.textContent = u.finished ? 'Unfollowing finished' : 'Unfollowing…';
    r.log.replaceChildren(...u.log.slice().reverse().map((e) =>
      h('div', {}, h('span', { class: e.ok ? 'ok' : 'no' }, e.ok ? '✓ ' : '✗ '), '@' + e.u.username, e.ok ? '' : h('span', { class: 'muted' }, '  — ' + e.why))));
  }

  /* ───────────────────────── External control ───────────────────────── */
  const busy = () => S.screen === 'scan' || (S.screen === 'unfollow' && !S.unf?.finished);
  const beforeUnload = (e) => { if (busy()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  const api = {
    open() { wrap.style.display = ''; fab.style.display = 'none'; },
    hide() { wrap.style.display = 'none'; fab.style.display = ''; },
    close() {
      const done = () => { S.ctrl.stopped = true; window.removeEventListener('beforeunload', beforeUnload); KEY_EVENTS.forEach((t) => window.removeEventListener(t, keyGuard, true)); host.remove(); delete window.__IGTA__; };
      if (busy()) confirmBox('The running task will be stopped.', 'Close', done); else done();
    },
  };
  window.__IGTA__ = api;
  render();
  console.log('%cMVP Instagram Tracker opened', 'color:#dd2a7b;font-weight:bold');
})();
