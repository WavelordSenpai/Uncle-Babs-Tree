(() => {
  'use strict';

  const ADMIN_EMAIL = 'vireshsingh26@protonmail.com';

  // State (adminToken lives strictly in JS memory, never localStorage)
  let adminToken = null;
  let authStatus = { authenticated: false, configured: true, source: 'env' };
  let people = [];
  let songs = [];
  let ytQueue = [];
  let reports = [];

  let activeTab = 'tree';
  let treeZoom = 1;
  let treeQuery = '';
  let albumView = 'people';
  let currentTrackIdx = -1;
  let isShuffle = false;
  let repeatMode = 'all'; // 'off' | 'all' | 'one'
  let activeYtItem = null;

  // Web Audio Visualizer nodes
  let audioCtx = null;
  let analyser = null;
  let mediaSource = null;
  let visualizerRaf = null;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safePhotoUrl(filename) {
    if (!filename) return '';
    return '/images/' + encodeURIComponent(String(filename).trim());
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function toast(message) {
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const item = document.createElement('div');
    item.className = 'toast';
    item.textContent = message;
    stack.appendChild(item);
    setTimeout(() => {
      item.remove();
    }, 3600);
  }

  async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (adminToken) {
      headers.set('Authorization', `Bearer ${adminToken}`);
    }
    const res = await fetch(url, { ...options, headers });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      if (res.status === 401 && adminToken) {
        setAdminSession(null);
      }
      throw new Error((data && data.error) || `Request failed (${res.status})`);
    }
    return data;
  }

  function setAdminSession(token) {
    adminToken = token || null;
    const isAdmin = Boolean(adminToken);
    document.body.classList.toggle('admin', isAdmin);
    const badge = document.getElementById('modeBadge');
    const adminBtn = document.getElementById('adminBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    if (badge) badge.textContent = isAdmin ? 'Admin Mode Active' : 'Guest View';
    if (adminBtn) adminBtn.textContent = isAdmin ? 'Admin Active' : 'Admin Access';
    if (logoutBtn) logoutBtn.hidden = !isAdmin;
    renderAll();
    if (isAdmin) {
      loadReports();
    }
  }

  // Genealogy helpers
  function getP(id) {
    return people.find((p) => p.id === id) || null;
  }

  function getChildrenOf(personId) {
    return people.filter((p) => p.father === personId || p.mother === personId);
  }

  function getCoupleChildren(p1, p2) {
    const id1 = p1 ? p1.id : null;
    const id2 = p2 ? p2.id : null;
    return people.filter((child) => {
      if (id1 && id2) {
        const match1 = child.father === id1 || child.mother === id1;
        const match2 = child.father === id2 || child.mother === id2;
        if (match1 && match2) return true;
        // Include single-parent match if other parent isn't set
        if (match1 && !child.father && child.mother === id1) return true;
        if (match1 && !child.mother && child.father === id1) return true;
        if (match2 && !child.father && child.mother === id2) return true;
        if (match2 && !child.mother && child.father === id2) return true;
        return false;
      }
      if (id1) return child.father === id1 || child.mother === id1;
      return false;
    });
  }

  function calcGen(p, seen) {
    const visited = seen || new Set();
    if (!p || visited.has(p.id)) return 0;
    visited.add(p.id);
    const f = getP(p.father);
    const m = getP(p.mother);
    if (!f && !m) return 0;
    return Math.max(calcGen(f, new Set(visited)), calcGen(m, new Set(visited))) + 1;
  }

  function isConnectedInTree(p) {
    if (!p) return false;
    if (p.father || p.mother || p.spouse) return true;
    return people.some((other) => other.father === p.id || other.mother === p.id || other.spouse === p.id);
  }

  function updateStats() {
    const uniquePhotos = new Set();
    people.forEach((p) => (p.photos || []).forEach((ph) => uniquePhotos.add(ph)));
    const elP = document.getElementById('statPeople');
    const elPh = document.getElementById('statPhotos');
    const elT = document.getElementById('statTracks');
    const elV = document.getElementById('statVideos');
    if (elP) elP.textContent = String(people.length);
    if (elPh) elPh.textContent = String(uniquePhotos.size);
    if (elT) elT.textContent = String(songs.length);
    if (elV) elV.textContent = String(ytQueue.length);
  }

  function switchTab(tabId) {
    activeTab = tabId;
    document.querySelectorAll('.nav-link[data-tab]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('main .tab-panel').forEach((sec) => {
      sec.hidden = sec.id !== `tab-${tabId}`;
    });
  }

  // Tree Rendering
  function nodeHtml(p) {
    const photo = (p.photos || [])[0];
    const initial = esc((p.name || '?').charAt(0).toUpperCase());
    const avatar = photo
      ? `<img src="${safePhotoUrl(photo)}" alt="${esc(p.name)}" loading="lazy" onerror="this.remove();this.parentElement.textContent='${initial}'">`
      : initial;
    const match = treeQuery && p.name.toLowerCase().includes(treeQuery);
    const photoCount = (p.photos || []).length;
    const subText = p.relation || `${photoCount} photo${photoCount === 1 ? '' : 's'}`;
    return `
      <div class="tree-node${match ? ' is-highlighted' : ''}" data-person-id="${esc(p.id)}" role="button" tabindex="0">
        <div class="node-avatar">${avatar}</div>
        <div class="node-name">${esc(p.name)}</div>
        <div class="node-meta">${esc(subText)}</div>
      </div>
    `;
  }

  function renderTreeBranch(person, renderedIds) {
    if (!person || renderedIds.has(person.id)) return '';
    renderedIds.add(person.id);

    const spouse = person.spouse ? getP(person.spouse) : null;
    if (spouse && !renderedIds.has(spouse.id)) {
      renderedIds.add(spouse.id);
    }
    const partner = spouse && spouse.id !== person.id ? spouse : null;
    const children = getCoupleChildren(person, partner).filter((c) => !renderedIds.has(c.id));

    const coupleHtml = partner
      ? `<div class="tree-couple-row">${nodeHtml(person)}<div class="marriage-bridge" aria-hidden="true"></div>${nodeHtml(partner)}</div>`
      : `<div class="tree-couple-row">${nodeHtml(person)}</div>`;

    let childrenHtml = '';
    if (children.length > 0) {
      const branches = children
        .map((child) => `<div class="tree-child-branch">${renderTreeBranch(child, renderedIds)}</div>`)
        .join('');
      childrenHtml = `
        <div class="tree-stem-down" aria-hidden="true"></div>
        <div class="tree-children-wrap${children.length === 1 ? ' single-child' : ''}">
          ${branches}
        </div>
      `;
    }

    return `<div class="tree-unit">${coupleHtml}${childrenHtml}</div>`;
  }

  function renderTree() {
    const el = document.getElementById('tree');
    const status = document.getElementById('loadStatus');
    const unlinkedSec = document.getElementById('unlinkedSection');
    const unlinkedGrid = document.getElementById('unlinkedGrid');
    if (!el) return;

    const connected = people.filter((p) => isConnectedInTree(p));
    const unlinked = people.filter((p) => !isConnectedInTree(p));

    if (status) {
      status.textContent = `${people.length} family members · ${connected.length} connected in tree · ${unlinked.length} awaiting placement`;
    }

    const renderedIds = new Set();
    // Root ancestors: connected members with no parents in the dataset (preferring those with children)
    const roots = connected
      .filter((p) => !getP(p.father) && !getP(p.mother))
      .sort((a, b) => {
        const ac = getChildrenOf(a.id).length;
        const bc = getChildrenOf(b.id).length;
        return bc - ac;
      });

    const units = [];
    for (const r of roots) {
      if (renderedIds.has(r.id)) continue;
      // Skip if spouse has parents (let spouse's lineage anchor the couple)
      const sp = r.spouse ? getP(r.spouse) : null;
      if (sp && (getP(sp.father) || getP(sp.mother))) continue;
      units.push(renderTreeBranch(r, renderedIds));
    }

    // Any remaining connected nodes not reached from top roots
    for (const p of connected) {
      if (!renderedIds.has(p.id)) {
        units.push(renderTreeBranch(p, renderedIds));
      }
    }

    el.innerHTML = units.length
      ? `<div class="tree-forest">${units.join('')}</div>`
      : '<div class="empty-state">No tree connections defined yet. Sign in as Admin to link parents and spouses.</div>';

    el.style.transform = `scale(${treeZoom})`;
    const zoomReadout = document.getElementById('zoomReadout');
    if (zoomReadout) zoomReadout.textContent = `${Math.round(treeZoom * 100)}%`;

    if (unlinkedSec && unlinkedGrid) {
      unlinkedSec.hidden = unlinked.length === 0;
      unlinkedGrid.innerHTML = unlinked
        .map((p) => {
          const highlight = treeQuery && p.name.toLowerCase().includes(treeQuery);
          const photo = (p.photos || [])[0];
          const initial = esc((p.name || '?').charAt(0).toUpperCase());
          const avatar = photo
            ? `<img src="${safePhotoUrl(photo)}" alt="${esc(p.name)}" loading="lazy" onerror="this.remove();this.parentElement.textContent='${initial}'">`
            : initial;
          return `
            <div class="tree-node${highlight ? ' is-highlighted' : ''}" data-person-id="${esc(p.id)}" role="button" tabindex="0">
              <div class="node-avatar">${avatar}</div>
              <div class="node-name">${esc(p.name)}</div>
              <div class="node-meta">${esc(p.relation || 'Family Portrait')}</div>
              ${adminToken ? `<button type="button" class="btn-outline btn-sm" data-edit-id="${esc(p.id)}">Link to Tree</button>` : ''}
            </div>
          `;
        })
        .join('');
    }
  }

  // Album Rendering
  function renderAlbum() {
    const el = document.getElementById('album');
    const countLabel = document.getElementById('albumCountLabel');
    if (!el) return;

    const q = (document.getElementById('search')?.value || '').trim().toLowerCase();
    const filter = document.getElementById('albumFilter')?.value || 'all';

    const filteredPeople = people.filter((p) => {
      const hay = `${p.name} ${p.relation || ''} ${p.desc || ''} ${(p.photos || []).join(' ')}`.toLowerCase();
      if (q && !hay.includes(q)) return false;
      if (filter === 'connected') return isConnectedInTree(p);
      if (filter === 'multi') return (p.photos || []).length > 1;
      if (filter === 'unlinked') return !isConnectedInTree(p);
      return true;
    });

    if (albumView === 'photos') {
      const photoCards = [];
      filteredPeople.forEach((p) => {
        (p.photos || []).forEach((ph, idx) => {
          photoCards.push({ person: p, filename: ph, idx });
        });
      });

      if (countLabel) {
        countLabel.textContent = `Showing ${photoCards.length} portrait${photoCards.length === 1 ? '' : 's'} across ${filteredPeople.length} members`;
      }

      if (!photoCards.length) {
        el.innerHTML = '<div class="empty-state">No matching photos found.</div>';
        return;
      }

      el.innerHTML = photoCards
        .map(({ person, filename, idx }) => {
          const initial = esc((person.name || '?').charAt(0).toUpperCase());
          return `
            <article class="album-card">
              <div class="album-photo-box" data-person-id="${esc(person.id)}" data-photo-idx="${idx}">
                <img src="${safePhotoUrl(filename)}" alt="${esc(person.name)}" loading="lazy" onerror="this.outerHTML='<div class=&quot;album-photo-fallback&quot;>${initial}</div>'">
              </div>
              <div class="album-card-body">
                <h3 class="album-card-title">${esc(person.name)}</h3>
                <p class="album-card-sub">${esc(person.relation || 'Family Archive')} · ${esc(filename)}</p>
                <div class="album-card-actions">
                  <button type="button" class="btn-outline btn-sm" data-person-id="${esc(person.id)}" data-photo-idx="${idx}">Inspect</button>
                  <button type="button" class="link-btn" data-download-file="${esc(filename)}">Download</button>
                </div>
              </div>
            </article>
          `;
        })
        .join('');
      return;
    }

    if (countLabel) {
      countLabel.textContent = `Showing ${filteredPeople.length} of ${people.length} family members`;
    }

    if (!filteredPeople.length) {
      el.innerHTML = '<div class="empty-state">No family members match your search.</div>';
      return;
    }

    el.innerHTML = filteredPeople
      .map((p) => {
        const primary = (p.photos || [])[0];
        const count = (p.photos || []).length;
        const initial = esc((p.name || '?').charAt(0).toUpperCase());
        const imgHtml = primary
          ? `<img src="${safePhotoUrl(primary)}" alt="${esc(p.name)}" loading="lazy" onerror="this.outerHTML='<div class=&quot;album-photo-fallback&quot;>${initial}</div>'">`
          : `<div class="album-photo-fallback">${initial}</div>`;
        return `
          <article class="album-card">
            <div class="album-photo-box" data-person-id="${esc(p.id)}" data-photo-idx="0">
              ${imgHtml}
            </div>
            <div class="album-card-body">
              <h3 class="album-card-title">${esc(p.name)}</h3>
              <p class="album-card-sub">${esc(p.relation || 'Family Member')} · <span class="mono-num">${count}</span> photo${count === 1 ? '' : 's'}</p>
              <p class="muted-text">${esc(p.desc || '')}</p>
              <div class="album-card-actions">
                <button type="button" class="btn-outline btn-sm" data-person-id="${esc(p.id)}">View Profile</button>
                ${primary ? `<button type="button" class="link-btn" data-download-file="${esc(primary)}">Download Photo</button>` : ''}
              </div>
            </div>
          </article>
        `;
      })
      .join('');
  }

  // Directory Table Rendering
  function renderList() {
    const tbody = document.getElementById('list');
    if (!tbody) return;
    const q = (document.getElementById('listSearch')?.value || '').trim().toLowerCase();
    const sortBy = document.getElementById('listSort')?.value || 'default';

    let rows = people.filter((p) => {
      if (!q) return true;
      return `${p.name} ${p.relation || ''} ${p.desc || ''}`.toLowerCase().includes(q);
    });

    if (sortBy === 'name') {
      rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === 'generation') {
      rows = [...rows].sort((a, b) => calcGen(a) - calcGen(b) || a.name.localeCompare(b.name));
    } else if (sortBy === 'photos') {
      rows = [...rows].sort((a, b) => (b.photos || []).length - (a.photos || []).length);
    }

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6">No matching members found.</td></tr>';
      return;
    }

    tbody.innerHTML = rows
      .map((p) => {
        const photo = (p.photos || [])[0];
        const initial = esc((p.name || '?').charAt(0).toUpperCase());
        const thumb = photo
          ? `<img class="dir-thumb" src="${safePhotoUrl(photo)}" alt="${esc(p.name)}" loading="lazy" onerror="this.outerHTML='<span class=&quot;dir-thumb-fallback&quot;>${initial}</span>'">`
          : `<span class="dir-thumb-fallback">${initial}</span>`;

        const links = [];
        const f = getP(p.father);
        const m = getP(p.mother);
        const sp = getP(p.spouse);
        if (f) links.push(`Father: ${f.name}`);
        if (m) links.push(`Mother: ${m.name}`);
        if (sp) links.push(`Spouse: ${sp.name}`);

        const genLabel = isConnectedInTree(p) ? `Gen ${calcGen(p) + 1}` : 'Archive';

        return `
          <tr>
            <td>
              <div class="dir-member-cell">
                ${thumb}
                <strong>${esc(p.name)}</strong>
              </div>
            </td>
            <td>${esc(p.relation || 'Family Member')}</td>
            <td class="muted-text">${esc(links.join(' · ') || '—')}</td>
            <td class="mono-num">${esc(genLabel)}</td>
            <td class="num-col mono-num">${(p.photos || []).length}</td>
            <td>
              <button type="button" class="btn-outline btn-sm" data-person-id="${esc(p.id)}">Profile</button>
              ${adminToken ? `<button type="button" class="btn-outline btn-sm" data-edit-id="${esc(p.id)}">Edit</button>` : ''}
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // Profile & Lightbox Modal
  function openProfile(id, initialPhotoIdx = 0) {
    const p = getP(id);
    const modal = document.getElementById('profileModal');
    const content = document.getElementById('profileContent');
    if (!p || !modal || !content) return;

    const photos = p.photos || [];
    const safeIdx = Math.min(Math.max(0, initialPhotoIdx), Math.max(0, photos.length - 1));
    const activePhoto = photos[safeIdx] || '';

    const f = getP(p.father);
    const m = getP(p.mother);
    const sp = getP(p.spouse);
    const kids = getChildrenOf(p.id);

    const relButton = (person) =>
      `<button type="button" class="link-btn" data-person-id="${esc(person.id)}">${esc(person.name)}</button>`;

    const thumbsHtml =
      photos.length > 1
        ? `<div class="lightbox-thumbs">
            ${photos
              .map(
                (ph, idx) => `
                  <button type="button" class="lightbox-thumb${idx === safeIdx ? ' is-active' : ''}" data-lightbox-src="${safePhotoUrl(ph)}" data-lightbox-file="${esc(ph)}">
                    <img src="${safePhotoUrl(ph)}" alt="${esc(p.name)} photo ${idx + 1}">
                  </button>
                `
              )
              .join('')}
          </div>`
        : '';

    const stageHtml = activePhoto
      ? `<img id="lightboxMainImg" src="${safePhotoUrl(activePhoto)}" alt="${esc(p.name)}">`
      : `<div class="album-photo-fallback">${esc((p.name || '?').charAt(0).toUpperCase())}</div>`;

    content.innerHTML = `
      <div class="profile-layout">
        <div>
          <div class="lightbox-stage">${stageHtml}</div>
          ${thumbsHtml}
        </div>
        <div class="profile-details">
          <p class="hero-kicker">${esc(p.relation || 'Ramsingh Family Archive')}</p>
          <h2 id="profileModalTitle" class="section-heading">${esc(p.name)}</h2>
          <p>${esc(p.desc || 'Preserved in Bab\'s Family Album.')}</p>
          <div class="profile-relations">
            <div><strong>Father:</strong> ${f ? relButton(f) : '<span class="muted-text">Not linked</span>'}</div>
            <div><strong>Mother:</strong> ${m ? relButton(m) : '<span class="muted-text">Not linked</span>'}</div>
            <div><strong>Spouse:</strong> ${sp ? relButton(sp) : '<span class="muted-text">Not linked</span>'}</div>
            <div><strong>Children:</strong> ${kids.length ? kids.map(relButton).join(' · ') : '<span class="muted-text">None listed</span>'}</div>
          </div>
          <div class="modal-actions">
            ${activePhoto ? `<button type="button" class="btn-primary" id="lightboxDownloadBtn" data-download-file="${esc(activePhoto)}">Download Photo</button>` : ''}
            <button type="button" class="btn-outline" data-report-person="${esc(p.name)}">Report Correction</button>
            ${adminToken ? `<button type="button" class="btn-outline" data-edit-id="${esc(p.id)}">Edit Member</button>` : ''}
          </div>
        </div>
      </div>
    `;

    modal.hidden = false;
  }

  function downloadPhotoFile(filename) {
    if (!filename) return;
    const a = document.createElement('a');
    a.href = safePhotoUrl(filename);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Select dropdown population for Add / Edit Member forms
  function fillPersonSelect(selectId, excludeId, selectedVal) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const opts = ['<option value="">— None —</option>'];
    people
      .filter((p) => p.id !== excludeId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((p) => {
        const selAttr = p.id === selectedVal ? ' selected' : '';
        opts.push(`<option value="${esc(p.id)}"${selAttr}>${esc(p.name)}</option>`);
      });
    sel.innerHTML = opts.join('');
  }

  function fillSelects() {
    fillPersonSelect('fFather', null, '');
    fillPersonSelect('fMother', null, '');
    fillPersonSelect('fSpouse', null, '');
  }

  // YouTube Theater
  function parseYouTubeInput(raw) {
    const text = (raw || '').trim();
    if (!text) return null;
    if (/^[A-Za-z0-9_-]{11}$/.test(text)) {
      return { videoId: text };
    }
    try {
      const u = new URL(text.startsWith('http') ? text : `https://${text}`);
      const host = u.hostname.toLowerCase();
      if (host.includes('youtube.com') || host.includes('youtu.be')) {
        const list = u.searchParams.get('list');
        const v = u.searchParams.get('v');
        if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return { videoId: v, playlistId: list || '' };
        if (host === 'youtu.be') {
          const seg = u.pathname.split('/').filter(Boolean)[0];
          if (seg && /^[A-Za-z0-9_-]{11}$/.test(seg)) return { videoId: seg };
        }
        const pathMatch = u.pathname.match(/\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
        if (pathMatch) return { videoId: pathMatch[1] };
        if (list && /^[A-Za-z0-9_-]{10,64}$/.test(list)) return { playlistId: list };
      }
    } catch {
      // Not a URL — treat as search query
    }
    return null;
  }

  function playYouTubeItem(item, autoplay = true) {
    const iframe = document.getElementById('ytPlayer');
    const overlay = document.getElementById('ytEmptyOverlay');
    const nowBar = document.getElementById('ytNowBar');
    const nowTitle = document.getElementById('ytNowTitle');
    const nowAuthor = document.getElementById('ytNowAuthor');
    if (!iframe) return;

    let src = '';
    if (item.videoId) {
      src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(item.videoId)}?rel=0${autoplay ? '&autoplay=1' : ''}`;
    } else if (item.playlistId) {
      src = `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(item.playlistId)}${autoplay ? '&autoplay=1' : ''}`;
    }
    if (!src) return;

    iframe.src = src;
    if (overlay) overlay.hidden = true;
    activeYtItem = item;
    if (nowBar && nowTitle && nowAuthor) {
      nowTitle.textContent = item.title || 'YouTube Video';
      nowAuthor.textContent = [item.author, item.duration].filter(Boolean).join(' · ') || 'YouTube';
      nowBar.hidden = false;
    }
  }

  async function searchYouTube(query, autoPlayTop = true) {
    const wrap = document.getElementById('ytSearchResultsWrap');
    const grid = document.getElementById('ytSearchResults');
    if (!wrap || !grid) return;

    wrap.hidden = false;
    grid.innerHTML = '<div class="muted-text">Searching YouTube...</div>';

    try {
      const data = await apiFetch(`/api/youtube/search?q=${encodeURIComponent(query)}`);
      const videos = data.videos || [];
      if (!videos.length) {
        grid.innerHTML = '<div class="muted-text">No YouTube results found. Try another search or paste a direct video link.</div>';
        return;
      }
      grid.innerHTML = videos
        .map(
          (v) => `
          <button type="button" class="yt-result-card" data-yt-play-id="${esc(v.videoId)}" data-yt-title="${esc(v.title)}" data-yt-author="${esc(v.author)}" data-yt-dur="${esc(v.duration)}" data-yt-thumb="${esc(v.thumbnail)}">
            <div class="yt-result-thumb">
              <img src="${esc(v.thumbnail)}" alt="${esc(v.title)}" loading="lazy">
              ${v.duration ? `<span class="yt-duration mono-num">${esc(v.duration)}</span>` : ''}
            </div>
            <div class="yt-result-info">
              <span class="yt-result-title">${esc(v.title)}</span>
              <span class="muted-text">${esc(v.author)}</span>
            </div>
          </button>
        `
        )
        .join('');

      if (autoPlayTop && videos[0]) {
        playYouTubeItem(videos[0], true);
      }
    } catch (err) {
      grid.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    }
  }

  async function handleYouTubeInput(rawQuery) {
    const parsed = parseYouTubeInput(rawQuery);
    if (parsed) {
      const item = {
        videoId: parsed.videoId || '',
        playlistId: parsed.playlistId || '',
        title: parsed.videoId ? `YouTube Video (${parsed.videoId})` : `YouTube Playlist`,
        author: 'YouTube',
        duration: '',
      };
      playYouTubeItem(item, true);
      if (parsed.videoId) {
        try {
          const meta = await apiFetch(`/api/youtube/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${parsed.videoId}`)}`);
          item.title = meta.title || item.title;
          item.author = meta.author || item.author;
          item.thumbnail = meta.thumbnail || '';
          const nowTitle = document.getElementById('ytNowTitle');
          const nowAuthor = document.getElementById('ytNowAuthor');
          if (nowTitle) nowTitle.textContent = item.title;
          if (nowAuthor) nowAuthor.textContent = item.author;
        } catch {
          // Keep fallback title if oEmbed fails
        }
      }
      return;
    }
    await searchYouTube(rawQuery, true);
  }

  function renderYtQueue() {
    const list = document.getElementById('ytQueueList');
    if (!list) return;
    if (!ytQueue.length) {
      list.innerHTML = '<li class="empty-state">No saved YouTube favorites yet. Search or load a video and click "Save to Family Queue".</li>';
      return;
    }
    list.innerHTML = ytQueue
      .map(
        (v) => `
        <li class="track-item">
          <div class="track-meta">
            ${v.thumbnail ? `<img class="track-thumb" src="${esc(v.thumbnail)}" alt="">` : ''}
            <div class="track-text">
              <strong>${esc(v.title)}</strong>
              <span class="muted-text">${esc([v.author, v.duration].filter(Boolean).join(' · '))}</span>
            </div>
          </div>
          <div class="track-actions">
            <button type="button" class="btn-outline btn-sm" data-yt-play-id="${esc(v.videoId)}" data-yt-playlist-id="${esc(v.playlistId || '')}" data-yt-title="${esc(v.title)}" data-yt-author="${esc(v.author)}" data-yt-dur="${esc(v.duration)}">Play</button>
            ${adminToken ? `<button type="button" class="btn-outline btn-sm" data-yt-del="${esc(v.id)}">Remove</button>` : ''}
          </div>
        </li>
      `
      )
      .join('');
  }

  // MP3 Studio Player & Visualizer
  function ensureVisualizer() {
    const audio = document.getElementById('mp3Player');
    if (!audio || audioCtx) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      mediaSource = audioCtx.createMediaElementSource(audio);
      mediaSource.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch {
      audioCtx = null;
      analyser = null;
    }
  }

  function drawVisualizer() {
    const canvas = document.getElementById('audioVisualizer');
    const audio = document.getElementById('mp3Player');
    if (!canvas || !audio) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#D4AF37';
    const bars = 32;
    const barW = (w - (bars - 1) * 4) / bars;

    let data = null;
    if (analyser && !audio.paused) {
      data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
    }

    for (let i = 0; i < bars; i++) {
      const ratio = data ? data[i % data.length] / 255 : audio.paused ? 0.08 : 0.25;
      const barH = Math.max(4, ratio * (h - 14));
      const x = i * (barW + 4);
      const y = h - barH - 6;
      ctx.fillStyle = accent;
      ctx.globalAlpha = audio.paused ? 0.3 : 0.85;
      ctx.fillRect(x, y, barW, barH);
    }
    ctx.globalAlpha = 1;

    if (!audio.paused) {
      visualizerRaf = requestAnimationFrame(drawVisualizer);
    }
  }

  function syncPlayerUI() {
    const audio = document.getElementById('mp3Player');
    const playBtn = document.getElementById('audioPlayBtn');
    const miniPlayBtn = document.getElementById('miniPlayBtn');
    const miniPlayer = document.getElementById('miniPlayer');
    const track = songs[currentTrackIdx] || null;

    if (playBtn) playBtn.textContent = audio && !audio.paused ? 'Pause' : 'Play';
    if (miniPlayBtn) miniPlayBtn.textContent = audio && !audio.paused ? 'Pause' : 'Play';

    if (track && miniPlayer) {
      miniPlayer.hidden = false;
      document.getElementById('miniTitle').textContent = track.title;
      document.getElementById('miniArtist').textContent = track.artist || 'Family Archive';
    } else if (miniPlayer) {
      miniPlayer.hidden = true;
    }
    renderPlaylist();
  }

  function playSongAt(idx) {
    if (!songs.length) return;
    if (idx < 0) idx = songs.length - 1;
    if (idx >= songs.length) idx = 0;
    currentTrackIdx = idx;
    const track = songs[idx];
    const audio = document.getElementById('mp3Player');
    if (!audio || !track) return;

    document.getElementById('audioTrackTitle').textContent = track.title;
    document.getElementById('audioTrackArtist').textContent = track.artist || 'Uploaded MP3';

    audio.src = track.url;
    ensureVisualizer();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    audio.play().then(() => {
      syncPlayerUI();
      drawVisualizer();
    }).catch((err) => {
      toast(`Could not play audio: ${err.message}`);
    });
  }

  function nextTrack() {
    if (!songs.length) return;
    if (isShuffle && songs.length > 1) {
      let rand = Math.floor(Math.random() * songs.length);
      if (rand === currentTrackIdx) rand = (rand + 1) % songs.length;
      playSongAt(rand);
      return;
    }
    playSongAt(currentTrackIdx + 1);
  }

  function prevTrack() {
    if (!songs.length) return;
    const audio = document.getElementById('mp3Player');
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    playSongAt(currentTrackIdx - 1);
  }

  function renderPlaylist() {
    const ul = document.getElementById('playlist');
    const countEl = document.getElementById('playlistCount');
    if (countEl) countEl.textContent = `${songs.length} track${songs.length === 1 ? '' : 's'}`;
    if (!ul) return;

    if (!songs.length) {
      ul.innerHTML = '<li class="empty-state">No MP3 tracks uploaded yet. Drop MP3 files above (such as <em>Suhani Raat Dhal Chuki Na</em>) to build the family playlist.</li>';
      return;
    }

    ul.innerHTML = songs
      .map(
        (s, i) => `
        <li class="track-item${i === currentTrackIdx ? ' is-playing' : ''}">
          <div class="track-meta">
            <div class="track-text">
              <strong>${esc(s.title)}</strong>
              <span class="muted-text">${esc(s.artist || 'Family Archive')}</span>
            </div>
          </div>
          <div class="track-actions">
            <button type="button" class="btn-outline btn-sm" data-song-play="${i}">${i === currentTrackIdx && !document.getElementById('mp3Player').paused ? 'Playing' : 'Play'}</button>
            <a class="btn-outline btn-sm" href="${esc(s.url)}" download="${esc(s.filename)}" style="text-decoration:none;display:inline-flex;align-items:center;">Save</a>
            ${adminToken ? `<button type="button" class="btn-outline btn-sm" data-song-del="${esc(s.id)}">Delete</button>` : ''}
          </div>
        </li>
      `
      )
      .join('');
  }

  function uploadMp3Files(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const statusEl = document.getElementById('mp3UploadStatus');
    const artistVal = document.getElementById('mp3ArtistInput')?.value.trim() || '';

    const fd = new FormData();
    if (artistVal) fd.append('artist', artistVal);
    files.forEach((f) => fd.append('tracks', f));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/songs');
    if (adminToken) xhr.setRequestHeader('Authorization', `Bearer ${adminToken}`);

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && statusEl) {
        const pct = Math.round((ev.loaded / ev.total) * 100);
        statusEl.textContent = `Uploading ${files.length} file(s)... ${pct}%`;
      }
    };

    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (statusEl) statusEl.textContent = `Uploaded ${files.length} track(s) to family playlist.`;
        toast(`Uploaded ${files.length} audio file(s)`);
        await loadSongs();
        if (songs.length > 0) {
          playSongAt(0);
        }
      } else {
        let msg = 'Upload failed.';
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch {}
        if (statusEl) statusEl.textContent = msg;
        toast(msg);
      }
    };

    xhr.onerror = () => {
      if (statusEl) statusEl.textContent = 'Network error during upload.';
      toast('Network error during upload.');
    };

    xhr.send(fd);
  }

  // Reports Rendering (Admin)
  function renderErrors() {
    const el = document.getElementById('errorLog');
    if (!el) return;
    if (!adminToken) {
      el.innerHTML = '<p class="muted-text">Sign in as Admin to review and resolve submitted correction reports.</p>';
      return;
    }
    if (!reports.length) {
      el.innerHTML = '<p class="muted-text">No correction reports submitted yet.</p>';
      return;
    }
    el.innerHTML = reports
      .map(
        (r) => `
        <div class="report-item">
          <div class="subsection-row" style="margin-bottom:0">
            <strong>${esc(r.person)}</strong>
            <span class="mono-num muted-text">${esc(r.status)} · ${esc(new Date(r.date).toLocaleDateString())}</span>
          </div>
          <p>${esc(r.msg)}</p>
          <div class="subsection-row" style="margin-bottom:0">
            <span class="muted-text">From: ${esc(r.name)}</span>
            ${r.status !== 'Fixed' ? `<button type="button" class="btn-outline btn-sm" data-fix-report="${esc(r.id)}">Mark Fixed</button>` : ''}
          </div>
        </div>
      `
      )
      .join('');
  }

  // Exports
  function exportJSON() {
    const blob = new Blob([JSON.stringify(people, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'family.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportMD() {
    const md = people
      .map((p) => {
        const f = getP(p.father)?.name || '';
        const m = getP(p.mother)?.name || '';
        const sp = getP(p.spouse)?.name || '';
        return `## ${p.name}\nRelation: ${p.relation || ''}\nPhotos: ${(p.photos || []).join(', ')}\nDescription: ${p.desc || ''}\nFather: ${f}\nMother: ${m}\nSpouse: ${sp}\n`;
      })
      .join('\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'babs-family.md';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Admin & Edit Modals
  async function openAdminModal() {
    if (adminToken) {
      setAdminSession(null);
      toast('Signed out of Admin mode');
      return;
    }
    try {
      authStatus = await apiFetch('/api/auth/status');
    } catch {
      authStatus = { configured: true, source: 'env' };
    }

    const modal = document.getElementById('adminModal');
    const title = document.getElementById('adminModalTitle');
    const desc = document.getElementById('adminModalDesc');
    const confirmWrap = document.getElementById('adminConfirmWrap');
    const confirmInput = document.getElementById('adminConfirmInput');
    const passInput = document.getElementById('adminPassInput');
    const submitBtn = document.getElementById('adminSubmitBtn');
    const errEl = document.getElementById('adminAuthError');

    errEl.hidden = true;
    passInput.value = '';
    confirmInput.value = '';

    if (!authStatus.configured) {
      title.textContent = 'Set Up Admin Passcode';
      desc.textContent = 'First-time setup: choose a passcode (4+ characters) to protect family tree edits and archive management.';
      confirmWrap.hidden = false;
      confirmInput.required = true;
      submitBtn.textContent = 'Save Passcode & Unlock';
    } else {
      title.textContent = 'Admin Access';
      desc.textContent = 'Enter your Admin passcode to add or edit family members, upload portraits, and manage reports.';
      confirmWrap.hidden = true;
      confirmInput.required = false;
      submitBtn.textContent = 'Unlock Admin Mode';
    }
    modal.hidden = false;
    passInput.focus();
  }

  function openEditPersonModal(id) {
    if (!adminToken) {
      openAdminModal();
      return;
    }
    const p = getP(id);
    if (!p) return;
    document.getElementById('eId').value = p.id;
    document.getElementById('eName').value = p.name;
    document.getElementById('eRelation').value = p.relation || '';
    document.getElementById('eDesc').value = p.desc || '';
    document.getElementById('ePhotos').value = (p.photos || []).join(', ');
    document.getElementById('ePhotoFiles').value = '';
    fillPersonSelect('eFather', p.id, p.father || '');
    fillPersonSelect('eMother', p.id, p.mother || '');
    fillPersonSelect('eSpouse', p.id, p.spouse || '');
    document.getElementById('profileModal').hidden = true;
    document.getElementById('editPersonModal').hidden = false;
  }

  function openReportModal(personName = '') {
    document.getElementById('rPerson').value = personName;
    document.getElementById('rMsg').value = '';
    document.getElementById('reportModal').hidden = false;
  }

  async function uploadPortraitFiles(fileInput) {
    const files = Array.from(fileInput?.files || []);
    if (!files.length) return [];
    const fd = new FormData();
    files.forEach((f) => fd.append('photos', f));
    const res = await apiFetch('/api/photos', { method: 'POST', body: fd });
    return res.files || [];
  }

  // Data Loaders
  async function loadFamily() {
    try {
      people = await apiFetch('/api/family');
      renderAll();
    } catch {
      const st = document.getElementById('loadStatus');
      if (st) st.textContent = 'Unable to load family data.';
    }
  }

  async function loadSongs() {
    try {
      songs = await apiFetch('/api/songs');
      renderPlaylist();
      updateStats();
    } catch {
      songs = [];
    }
  }

  async function loadYtQueue() {
    try {
      ytQueue = await apiFetch('/api/youtube/queue');
      renderYtQueue();
      updateStats();
    } catch {
      ytQueue = [];
    }
  }

  async function loadReports() {
    if (!adminToken) return;
    try {
      reports = await apiFetch('/api/reports');
      renderErrors();
    } catch {
      reports = [];
    }
  }

  function renderAll() {
    renderTree();
    renderAlbum();
    renderList();
    renderPlaylist();
    renderYtQueue();
    renderErrors();
    fillSelects();
    updateStats();
  }

  // Boot & Event Delegation
  document.addEventListener('DOMContentLoaded', () => {
    // Theme persistence
    const themeSel = document.getElementById('themeSelect');
    try {
      const savedTheme = localStorage.getItem('babs-theme');
      if (savedTheme) {
        document.body.dataset.theme = savedTheme;
        if (themeSel) themeSel.value = savedTheme;
      }
    } catch {}
    if (themeSel) {
      themeSel.addEventListener('change', () => {
        document.body.dataset.theme = themeSel.value;
        try {
          localStorage.setItem('babs-theme', themeSel.value);
        } catch {}
        drawVisualizer();
      });
    }

    // Navigation tabs
    document.querySelectorAll('.nav-link[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    document.querySelector('[data-nav-brand]')?.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab('tree');
    });
    document.getElementById('quickMusicBtn')?.addEventListener('click', () => switchTab('music'));
    document.getElementById('miniOpenMusicBtn')?.addEventListener('click', () => switchTab('music'));

    // Tree controls
    document.getElementById('treeSearch')?.addEventListener('input', (e) => {
      treeQuery = e.target.value.trim().toLowerCase();
      renderTree();
    });
    document.getElementById('zoomInBtn')?.addEventListener('click', () => {
      treeZoom = Math.min(1.5, Number((treeZoom + 0.1).toFixed(2)));
      renderTree();
    });
    document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
      treeZoom = Math.max(0.55, Number((treeZoom - 0.1).toFixed(2)));
      renderTree();
    });
    document.getElementById('zoomResetBtn')?.addEventListener('click', () => {
      treeZoom = 1;
      renderTree();
    });
    document.getElementById('treeAddBtn')?.addEventListener('click', () => switchTab('vault'));

    // Album & Directory filters
    document.getElementById('search')?.addEventListener('input', renderAlbum);
    document.getElementById('albumFilter')?.addEventListener('change', renderAlbum);
    document.querySelectorAll('[data-album-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        albumView = btn.dataset.albumView;
        document.querySelectorAll('[data-album-view]').forEach((b) => b.classList.toggle('is-active', b === btn));
        renderAlbum();
      });
    });
    document.getElementById('listSearch')?.addEventListener('input', renderList);
    document.getElementById('listSort')?.addEventListener('change', renderList);

    // YouTube Form & Presets
    document.getElementById('ytForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = document.getElementById('ytInput').value.trim();
      if (val) handleYouTubeInput(val);
    });
    document.querySelectorAll('[data-yt-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = btn.dataset.ytPreset;
        document.getElementById('ytInput').value = q;
        searchYouTube(q, true);
      });
    });
    document.getElementById('clearYtResultsBtn')?.addEventListener('click', () => {
      document.getElementById('ytSearchResultsWrap').hidden = true;
    });
    document.getElementById('saveYtQueueBtn')?.addEventListener('click', async () => {
      if (!activeYtItem) return;
      try {
        await apiFetch('/api/youtube/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(activeYtItem),
        });
        toast('Saved to Family YouTube Queue');
        await loadYtQueue();
      } catch (err) {
        toast(err.message);
      }
    });

    // MP3 Player & Uploader
    const audio = document.getElementById('mp3Player');
    const seek = document.getElementById('audioSeek');
    const vol = document.getElementById('audioVolume');
    if (audio) {
      audio.volume = 0.9;
      audio.addEventListener('timeupdate', () => {
        const cur = audio.currentTime || 0;
        const dur = audio.duration || 0;
        document.getElementById('audioCurrentTime').textContent = formatTime(cur);
        document.getElementById('audioDuration').textContent = formatTime(dur);
        document.getElementById('miniTime').textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
        if (seek && dur > 0) seek.value = String((cur / dur) * 100);
      });
      audio.addEventListener('play', () => {
        syncPlayerUI();
        drawVisualizer();
      });
      audio.addEventListener('pause', () => {
        if (visualizerRaf) cancelAnimationFrame(visualizerRaf);
        syncPlayerUI();
        drawVisualizer();
      });
      audio.addEventListener('ended', () => {
        if (repeatMode === 'one') {
          audio.currentTime = 0;
          audio.play().catch(() => {});
        } else if (repeatMode === 'all' || currentTrackIdx < songs.length - 1) {
          nextTrack();
        } else {
          syncPlayerUI();
        }
      });
    }
    seek?.addEventListener('input', () => {
      if (audio && audio.duration > 0) {
        audio.currentTime = (Number(seek.value) / 100) * audio.duration;
      }
    });
    vol?.addEventListener('input', () => {
      if (audio) audio.volume = Number(vol.value);
    });

    function togglePlay() {
      if (!songs.length) {
        toast('Upload an MP3 file first to play audio.');
        return;
      }
      if (currentTrackIdx === -1) {
        playSongAt(0);
        return;
      }
      if (audio.paused) {
        ensureVisualizer();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        audio.play().catch(() => {});
      } else {
        audio.pause();
      }
    }

    document.getElementById('audioPlayBtn')?.addEventListener('click', togglePlay);
    document.getElementById('miniPlayBtn')?.addEventListener('click', togglePlay);
    document.getElementById('audioNextBtn')?.addEventListener('click', nextTrack);
    document.getElementById('miniNextBtn')?.addEventListener('click', nextTrack);
    document.getElementById('audioPrevBtn')?.addEventListener('click', prevTrack);
    document.getElementById('miniPrevBtn')?.addEventListener('click', prevTrack);

    document.getElementById('audioShuffleBtn')?.addEventListener('click', (e) => {
      isShuffle = !isShuffle;
      e.currentTarget.classList.toggle('is-active', isShuffle);
      e.currentTarget.textContent = isShuffle ? 'Shuffle On' : 'Shuffle';
    });
    document.getElementById('audioRepeatBtn')?.addEventListener('click', (e) => {
      repeatMode = repeatMode === 'all' ? 'one' : repeatMode === 'one' ? 'off' : 'all';
      e.currentTarget.classList.toggle('is-active', repeatMode !== 'off');
      e.currentTarget.textContent = repeatMode === 'one' ? 'Repeat 1' : repeatMode === 'all' ? 'Repeat All' : 'Repeat Off';
    });

    // Dropzone upload
    const dropzone = document.getElementById('mp3Dropzone');
    const mp3Input = document.getElementById('mp3Upload');
    document.getElementById('mp3BrowseBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      mp3Input?.click();
    });
    document.getElementById('mp3ArtistInput')?.addEventListener('click', (e) => e.stopPropagation());
    dropzone?.addEventListener('click', () => mp3Input?.click());
    dropzone?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        mp3Input?.click();
      }
    });
    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    });
    dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-dragover');
      if (e.dataTransfer?.files?.length) {
        uploadMp3Files(e.dataTransfer.files);
      }
    });
    mp3Input?.addEventListener('change', (e) => {
      if (e.target.files?.length) {
        uploadMp3Files(e.target.files);
        e.target.value = '';
      }
    });

    // Auth Modal & Admin Actions
    document.getElementById('adminBtn')?.addEventListener('click', openAdminModal);
    document.getElementById('vaultLoginBtn')?.addEventListener('click', openAdminModal);
    document.getElementById('logoutBtn')?.addEventListener('click', () => setAdminSession(null));
    document.getElementById('closeAdminBtn')?.addEventListener('click', () => (document.getElementById('adminModal').hidden = true));
    document.getElementById('cancelAdminBtn')?.addEventListener('click', () => (document.getElementById('adminModal').hidden = true));

    document.getElementById('adminAuthForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = document.getElementById('adminPassInput').value;
      const confirmPass = document.getElementById('adminConfirmInput').value;
      const errEl = document.getElementById('adminAuthError');
      errEl.hidden = true;

      try {
        if (!authStatus.configured) {
          if (pass !== confirmPass) {
            errEl.textContent = 'Passcodes do not match.';
            errEl.hidden = false;
            return;
          }
          const res = await apiFetch('/api/auth/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passcode: pass }),
          });
          document.getElementById('adminModal').hidden = true;
          setAdminSession(res.token);
          toast('Admin passcode created and unlocked');
        } else {
          const res = await apiFetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passcode: pass }),
          });
          document.getElementById('adminModal').hidden = true;
          setAdminSession(res.token);
          toast('Admin mode unlocked');
        }
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });

    // Add Person Form (Admin)
    document.getElementById('addPersonForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!adminToken) return openAdminModal();
      try {
        const uploaded = await uploadPortraitFiles(document.getElementById('fPhotoFiles'));
        const typed = document.getElementById('fPhotos').value.split(',').map((s) => s.trim()).filter(Boolean);
        const payload = {
          name: document.getElementById('fName').value.trim(),
          relation: document.getElementById('fRelation').value.trim(),
          desc: document.getElementById('fDesc').value.trim(),
          father: document.getElementById('fFather').value,
          mother: document.getElementById('fMother').value,
          spouse: document.getElementById('fSpouse').value,
          photos: [...new Set([...uploaded, ...typed])],
        };
        await apiFetch('/api/family', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        e.target.reset();
        toast('Family member saved and placed in tree');
        await loadFamily();
        switchTab('tree');
      } catch (err) {
        toast(err.message);
      }
    });

    // Edit Person Modal (Admin)
    document.getElementById('closeEditBtn')?.addEventListener('click', () => (document.getElementById('editPersonModal').hidden = true));
    document.getElementById('cancelEditBtn')?.addEventListener('click', () => (document.getElementById('editPersonModal').hidden = true));
    document.getElementById('editPersonForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('eId').value;
      try {
        const uploaded = await uploadPortraitFiles(document.getElementById('ePhotoFiles'));
        const typed = document.getElementById('ePhotos').value.split(',').map((s) => s.trim()).filter(Boolean);
        const payload = {
          name: document.getElementById('eName').value.trim(),
          relation: document.getElementById('eRelation').value.trim(),
          desc: document.getElementById('eDesc').value.trim(),
          father: document.getElementById('eFather').value,
          mother: document.getElementById('eMother').value,
          spouse: document.getElementById('eSpouse').value,
          photos: [...new Set([...typed, ...uploaded])],
        };
        await apiFetch(`/api/family/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        document.getElementById('editPersonModal').hidden = true;
        toast('Member details updated');
        await loadFamily();
      } catch (err) {
        toast(err.message);
      }
    });

    document.getElementById('deletePersonBtn')?.addEventListener('click', async () => {
      const id = document.getElementById('eId').value;
      if (!id) return;
      try {
        await apiFetch(`/api/family/${encodeURIComponent(id)}`, { method: 'DELETE' });
        document.getElementById('editPersonModal').hidden = true;
        toast('Member removed from archive');
        await loadFamily();
      } catch (err) {
        toast(err.message);
      }
    });

    // Report Correction Modal
    document.getElementById('heroReportBtn')?.addEventListener('click', () => openReportModal());
    document.getElementById('footerReportBtn')?.addEventListener('click', () => openReportModal());
    document.getElementById('closeReportBtn')?.addEventListener('click', () => (document.getElementById('reportModal').hidden = true));
    document.getElementById('cancelReportBtn')?.addEventListener('click', () => (document.getElementById('reportModal').hidden = true));

    document.getElementById('reportForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        name: document.getElementById('rName').value.trim(),
        person: document.getElementById('rPerson').value.trim(),
        msg: document.getElementById('rMsg').value.trim(),
      };
      try {
        await apiFetch('/api/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        document.getElementById('reportModal').hidden = true;
        toast(`Correction submitted to archive log (${ADMIN_EMAIL})`);
        if (adminToken) await loadReports();
      } catch (err) {
        toast(err.message);
      }
    });

    // Profile Modal Close & Exports
    document.getElementById('closeProfileBtn')?.addEventListener('click', () => (document.getElementById('profileModal').hidden = true));
    document.getElementById('exportJsonBtn')?.addEventListener('click', exportJSON);
    document.getElementById('exportMdBtn')?.addEventListener('click', exportMD);
    document.getElementById('printTreeBtn')?.addEventListener('click', () => {
      switchTab('tree');
      setTimeout(() => window.print(), 100);
    });

    // Global click delegation for dynamic cards, buttons, lightbox, playlists
    document.addEventListener('click', async (e) => {
      const target = e.target;

      // Backdrop click closes modal
      if (target.classList.contains('modal-backdrop')) {
        target.hidden = true;
        return;
      }

      const editBtn = target.closest('[data-edit-id]');
      if (editBtn) {
        e.stopPropagation();
        openEditPersonModal(editBtn.dataset.editId);
        return;
      }

      const dlBtn = target.closest('[data-download-file]');
      if (dlBtn) {
        e.stopPropagation();
        downloadPhotoFile(dlBtn.dataset.downloadFile);
        return;
      }

      const reportBtn = target.closest('[data-report-person]');
      if (reportBtn) {
        document.getElementById('profileModal').hidden = true;
        openReportModal(reportBtn.dataset.reportPerson);
        return;
      }

      const thumbBtn = target.closest('[data-lightbox-src]');
      if (thumbBtn) {
        const mainImg = document.getElementById('lightboxMainImg');
        const dl = document.getElementById('lightboxDownloadBtn');
        if (mainImg) mainImg.src = thumbBtn.dataset.lightboxSrc;
        if (dl) dl.dataset.downloadFile = thumbBtn.dataset.lightboxFile;
        document.querySelectorAll('.lightbox-thumb').forEach((b) => b.classList.toggle('is-active', b === thumbBtn));
        return;
      }

      const personTrigger = target.closest('[data-person-id]');
      if (personTrigger) {
        const idx = Number(personTrigger.dataset.photoIdx || 0);
        openProfile(personTrigger.dataset.personId, idx);
        return;
      }

      const ytBtn = target.closest('[data-yt-play-id], [data-yt-playlist-id]');
      if (ytBtn) {
        playYouTubeItem({
          videoId: ytBtn.dataset.ytPlayId || '',
          playlistId: ytBtn.dataset.ytPlaylistId || '',
          title: ytBtn.dataset.ytTitle || 'YouTube Video',
          author: ytBtn.dataset.ytAuthor || 'YouTube',
          duration: ytBtn.dataset.ytDur || '',
          thumbnail: ytBtn.dataset.ytThumb || '',
        }, true);
        return;
      }

      const ytDel = target.closest('[data-yt-del]');
      if (ytDel) {
        try {
          await apiFetch(`/api/youtube/queue/${encodeURIComponent(ytDel.dataset.ytDel)}`, { method: 'DELETE' });
          toast('Removed from YouTube queue');
          await loadYtQueue();
        } catch (err) {
          toast(err.message);
        }
        return;
      }

      const songPlay = target.closest('[data-song-play]');
      if (songPlay) {
        playSongAt(Number(songPlay.dataset.songPlay));
        return;
      }

      const songDel = target.closest('[data-song-del]');
      if (songDel) {
        try {
          await apiFetch(`/api/songs/${encodeURIComponent(songDel.dataset.songDel)}`, { method: 'DELETE' });
          toast('Track deleted');
          await loadSongs();
        } catch (err) {
          toast(err.message);
        }
        return;
      }

      const fixReport = target.closest('[data-fix-report]');
      if (fixReport) {
        try {
          await apiFetch(`/api/reports/${encodeURIComponent(fixReport.dataset.fixReport)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Fixed' }),
          });
          await loadReports();
        } catch (err) {
          toast(err.message);
        }
      }
    });

    // Keyboard accessibility for ESC closing modals & Enter on tree nodes
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop').forEach((m) => (m.hidden = true));
      } else if (e.key === 'Enter' && document.activeElement?.dataset?.personId) {
        openProfile(document.activeElement.dataset.personId, 0);
      }
    });

    // Initial data load
    loadFamily();
    loadSongs();
    loadYtQueue();
    drawVisualizer();
  });
})();
