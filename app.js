// Bab's Family Album - app.js | ADMIN PW 1919 | vireshsingh26@protonmail.com
const ADMIN_PW = "1919";
const ADMIN_EMAIL = "vireshsingh26@protonmail.com";
let isAdmin = false;
let errors = [];
let people = [];

const SONGS = [
  {title:"Suhani Raat Dhal Chuki Na", sub:"Dulari Songs - Suresh - Madhubala - Mohd Rafi", file:"songs/Suhani Raat Dhal Chuki Na - Dulari Songs - Suresh - Madhubala - Mohd Rafi.mp3"}
];

function getP(id){ return people.find(p=>p.id===id); }

function gen(p, seen){
  seen = seen || new Set();
  if(!p || seen.has(p.id)) return 0;
  seen.add(p.id);
  var f = getP(p.father), m = getP(p.mother);
  if(!f && !m) return 0;
  return Math.max(gen(f, seen), gen(m, seen)) + 1;
}

function photoHTML(p){
  var f = (p.photos||[])[0];
  if(f) return '<div class="avatar"><img src="images/' + f + '" onerror="this.outerHTML=\'<span>' + p.name[0] + '</span>\'" alt=""></div>';
  return '<div class="avatar">' + p.name[0] + '</div>';
}

function renderAll(){ renderTree(); renderAlbum(); renderList(); renderPlaylist(); renderErrors(); fillSelects(); }

function renderTree(){
  var el = document.getElementById('tree');
  if(!el) return;
  var gens = {};
  people.forEach(function(p){ var g = gen(p); (gens[g] = gens[g] || []).push(p); });
  document.getElementById('loadStatus').textContent = 'Loaded ' + people.length + ' people';
  el.innerHTML = Object.keys(gens).sort(function(a,b){return a-b}).map(function(g){
    return '<h3>Generation ' + (Number(g)+1) + '</h3><div class="tree-gen">' + gens[g].map(function(p){
      return '<div class="person" onclick="openProfile(\'' + p.id + '\')">' + photoHTML(p) + '<b>' + p.name + '</b><br><small>' + (p.relation||'') + '</small><br><small>' + (p.photos||[]).length + ' photo(s)</small></div>';
    }).join('') + '</div><div class="tree-connector"></div><div class="tree-sibling-bar"></div>';
  }).join('');
}

function renderAlbum(){
  var q = (document.getElementById('search').value || '').toLowerCase();
  document.getElementById('album').innerHTML = people.filter(function(p){ return p.name.toLowerCase().includes(q); }).map(function(p){
    return '<div class="person">' + photoHTML(p) + '<b>' + p.name + '</b><br><small>' + (p.desc||'') + '</small><br><button onclick="openProfile(\'' + p.id + '\')">View</button> <button onclick="downloadPhoto(\'' + p.id + '\')">Download Photo</button></div>';
  }).join('');
}

function renderList(){
  document.getElementById('list').innerHTML = people.map(function(p){
    return '<p><b>' + p.name + '</b> - ' + (p.relation||'') + ' - ' + (p.desc||'') + '</p>';
  }).join('');
}

function renderPlaylist(){
  document.getElementById('playlist').innerHTML = SONGS.map(function(s,i){
    return '<li><b>' + s.title + '</b><br><small>' + s.sub + '</small><br><small>' + s.file + '</small><br><button onclick="playSong(' + i + ')">Play</button></li>';
  }).join('');
}

function playSong(i){
  var a = document.getElementById('mp3Player');
  a.src = encodeURI(SONGS[i].file);
  a.play().catch(function(e){ logError('MP3 play failed', e.message); });
}

function loadYT(){
  var v = document.getElementById('ytInput').value.trim();
  if(!v) return;
  var id = v;
  var m = v.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  if(m) id = m[1];
  document.getElementById('ytPlayer').src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1';
}
function loadYTpreset(q){
  document.getElementById('ytPlayer').src = 'https://www.youtube-nocookie.com/embed?listType=search&list=' + encodeURIComponent(q);
}

function openProfile(id){
  var p = getP(id);
  if(!p) return;
  document.getElementById('profileContent').innerHTML = '<h2>' + p.name + '</h2><p>' + (p.desc||'') + '</p><p>Photos: ' + (p.photos||[]).join(', ') + '</p><button onclick="downloadPhoto(\'' + p.id + '\')">Download Photo</button> <button onclick="openReport(\'' + p.id + '\')">Report Error</button>';
  document.getElementById('profileModal').hidden = false;
}
function closeProfile(){ document.getElementById('profileModal').hidden = true; }

function downloadPhoto(id){
  var p = getP(id);
  var f = (p.photos||[])[0] || 'photo.jpg';
  var a = document.createElement('a');
  a.href = 'images/' + f;
  a.download = f;
  a.click();
}

function fillSelects(){
  ['fFather','fMother','fSpouse'].forEach(function(sid){
    var s = document.getElementById(sid);
    if(!s) return;
    s.innerHTML = '<option value="">-- None --</option>' + people.map(function(p){ return '<option value="' + p.id + '">' + p.name + '</option>'; }).join('');
  });
}

function addPerson(){
  if(!isAdmin){ alert('Admin only - login first'); return; }
  var name = document.getElementById('fName').value.trim();
  if(!name) return;
  var photos = document.getElementById('fPhotos').value.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  var ex = people.find(function(p){ return p.name.toLowerCase() === name.toLowerCase(); });
  if(ex){
    ex.photos = [...new Set([...(ex.photos||[]), ...photos])];
  } else {
    people.push({id:name.toLowerCase().replace(/[^a-z0-9]+/g,'-'), name:name, photos:photos, desc:document.getElementById('fDesc').value, father:document.getElementById('fFather').value, mother:document.getElementById('fMother').value, spouse:document.getElementById('fSpouse').value, relation:document.getElementById('fDesc').value});
  }
  renderAll();
  alert('Saved - tree auto-placed them');
}

function openReport(person){
  document.getElementById('reportModal').hidden = false;
  if(person) document.getElementById('rPerson').value = person;
}
function submitReport(){
  var r = {date:new Date().toISOString(), name:document.getElementById('rName').value, person:document.getElementById('rPerson').value, msg:document.getElementById('rMsg').value, status:'New'};
  errors.push(r);
  renderErrors();
  document.getElementById('reportModal').hidden = true;
  alert('Thank you - report sent to admin: ' + ADMIN_EMAIL);
  window.location.href = 'mailto:' + ADMIN_EMAIL + '?subject=' + encodeURIComponent('Family Tree Error - ' + r.person) + '&body=' + encodeURIComponent(r.msg + '\nFrom: ' + r.name);
}
function renderErrors(){
  var el = document.getElementById('errorLog');
  if(el) el.innerHTML = errors.map(function(e,i){ return '<p>' + e.date + ' | ' + e.person + ' | ' + e.msg + ' | ' + e.status + ' <button onclick="errors[' + i + '].status=\'Fixed\';renderErrors()">Mark Fixed</button></p>'; }).join('') || '<p>No errors yet.</p>';
}
function logError(w,m){ errors.push({date:new Date().toISOString(), person:'System', msg:w+': '+m, status:'New'}); renderErrors(); }

function exportMD(){
  if(!isAdmin) return alert('Admin only');
  var md = people.map(function(p){ return '## ' + p.name + '\nPhoto: ' + (p.photos||[]).join(', ') + '\nDescription: ' + (p.desc||'') + '\nFather: ' + (getP(p.father) ? getP(p.father).name : '') + '\nMother: ' + (getP(p.mother) ? getP(p.mother).name : '') + '\nSpouse: ' + (getP(p.spouse) ? getP(p.spouse).name : '') + '\n'; }).join('\n');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], {type:'text/markdown'}));
  a.download = 'babs-family.md';
  a.click();
}
function exportJSON(){
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(people, null, 2)], {type:'application/json'}));
  a.download = 'family.json';
  a.click();
}

document.addEventListener('DOMContentLoaded', function(){
  document.querySelectorAll('[data-tab]').forEach(function(b){
    b.onclick = function(){ document.querySelectorAll('main section').forEach(function(s){ s.hidden = true; }); document.getElementById('tab-' + b.dataset.tab).hidden = false; };
  });
  var th = document.getElementById('themeSelect');
  if(th) th.onchange = function(){ document.body.dataset.theme = th.value; try{ localStorage.setItem('babs-theme', th.value); }catch(e){} };
  try{ var s = localStorage.getItem('babs-theme'); if(s){ document.body.dataset.theme = s; if(th) th.value = s; } }catch(e){}
  document.getElementById('adminBtn').onclick = function(){
    var pw = prompt('Admin password:');
    if(pw === ADMIN_PW){ isAdmin = true; document.body.classList.add('admin'); document.getElementById('modeBadge').textContent = 'Admin Mode ON'; alert('Admin mode ON'); }
    else alert('Wrong password');
  };
  document.getElementById('logoutBtn').onclick = function(){ isAdmin = false; document.body.classList.remove('admin'); document.getElementById('modeBadge').textContent = 'Guest View'; };
  var up = document.getElementById('mp3Upload');
  if(up) up.onchange = function(e){ Array.from(e.target.files).forEach(function(f){ SONGS.push({title:f.name, sub:'Uploaded MP3', file:URL.createObjectURL(f)}); }); renderPlaylist(); };
  var se = document.getElementById('search');
  if(se) se.oninput = renderAlbum;

  // Load family from data/family.json - this is why app.js stays small
  fetch('data/family.json').then(function(r){ return r.json(); }).then(function(d){
    if(Array.isArray(d) && d.length){ people = d; renderAll(); }
  }).catch(function(){
    document.getElementById('loadStatus').textContent = 'ERROR: data/family.json not found - check folder';
  });
});
