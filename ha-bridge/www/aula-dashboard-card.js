const escapeAula = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const aulaDate = value => {
  const date = new Date(value);
  return Number.isNaN(+date) ? '' : date.toLocaleString('da-DK', {timeZone:'Europe/Copenhagen', day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
};
const aulaLabels = {calendar:'Kalender',messages:'Beskeder',posts:'Opslag',presence:'Fremmøde',presence_templates:'Komme/gå',notifications:'Notifikationer',ugeplan:'Ugeplan',opgaver:'Opgaver',ugebrev:'Ugebrev',huskelisten:'Huskeliste',lektier:'Lektier',profiles:'Profiler'};
const aulaArray = data => { if (Array.isArray(data)) return data; for (const key of ['threads','items','posts','events','data']) if (Array.isArray(data?.[key])) return data[key]; return []; };

class AulaDashboardCard extends HTMLElement {
  setConfig(config) { this.config = config; if (!this.shadowRoot) this.attachShadow({mode:'open'}); this.tab = 'indbakke'; this.inboxFilter = 'unread'; this.child = 'all'; this.page = 0; this.lessons = false; }
  set hass(value) {
    const changed = this._hass?.user?.id !== value.user?.id;
    this._hass = value;
    if (changed) { this.inboxData = null; this.inboxError = null; this.shadowRoot?.querySelector('.reader')?.remove(); }
    if (!this.started && this.isConnected) this.start();
    else if (changed && this.started) this.load();
  }
  connectedCallback() { if (this._hass) this.start(); }
  disconnectedCallback() { clearInterval(this.timer); this.started = false; }
  getCardSize() { return 15; }
  start() { if (this.started) return; this.started = true; this.load(); this.timer = setInterval(() => this.load(), 60000); }
  async load() {
    if (this.inboxUpdating) return;
    const generation = this.loadGeneration = (this.loadGeneration || 0) + 1;
    const owner = this._hass;
    try {
      const result = await owner.callApi('GET','aula_bridge/snapshot');
      if (generation !== this.loadGeneration || owner.user?.id !== this._hass.user?.id) return;
      this.snapshot = result.snapshot; this.available = result.available; this.error = null;
    } catch { this.error = 'Aula-data kunne ikke hentes. Kontrollér Aula Bridge under Settings → Devices & services.'; }
    await this.loadInbox(generation, owner);
    if (!this.shadowRoot?.querySelector('.reader') && !this.shadowRoot?.querySelector('#tools-details[open]')) this.render();
  }
  async loadInbox(generation, owner) {
    try {
      const data = await owner.callApi('GET', 'aula_bridge/inbox');
      if (generation !== this.loadGeneration || owner.user?.id !== this._hass.user?.id) return;
      this.inboxData = data; this.inboxError = null;
    } catch {
      if (generation !== this.loadGeneration || owner.user?.id !== this._hass.user?.id) return;
      this.inboxError = 'Din indbakke kunne ikke hentes. Prøv Opdatér. Læststatus er ikke ændret.';
    }
  }
  inboxItems() {
    return (this.inboxData?.items || []).filter(item => this.inboxFilter === 'archive'
      ? item.archived : !item.archived && (this.inboxFilter === 'all' || !item.read));
  }
  inbox() {
    const items = this.inboxItems();
    return `<div class="section-title"><h2>Din Aula-indbakke</h2><span class="pill">${Number(this.inboxData?.unread || 0)} ulæste</span></div>
      <p class="muted">${escapeAula(this._hass?.user?.name || 'Din bruger')} · Læst og arkiveret gælder kun dig. Beskederne bliver liggende hos den anden.</p>
      <div class="inbox-filters" role="group" aria-label="Indbakkefilter">${[['unread','Ulæste'],['all','Alle'],['archive','Arkiv']].map(([id,label])=>`<button data-inbox-filter="${id}" aria-pressed="${this.inboxFilter===id}">${label}</button>`).join('')}</div>
      ${this.inboxError ? `<div class="warning" role="alert">${escapeAula(this.inboxError)}</div>` : ''}
      ${this.inboxData?.error ? '<div class="warning">Aula-kontrollen har registreret en fejl. Oversigten kan mangle nye beskeder; kontrollér også Aula.</div>' : ''}
      ${this.inboxData?.enabled === false ? '<div class="warning">Automatisk Aula-analyse er slået fra.</div>' : ''}
      ${items.map(item=>{const r=item.result || {};return `<article class="inbox-item ${item.read?'':'unread'}"><div class="when">${escapeAula(aulaDate(item.created))}${item.test?' · Prøveanalyse':''}${item.state!=='ok'?' · Kræver gennemlæsning':''}</div><h3>${escapeAula(r.title || 'Aula · kræver gennemlæsning')}</h3><p class="text">${escapeAula(r.notification || 'Kilden kunne ikke analyseres sikkert. Læs den i Aula.')}</p><div class="inbox-actions"><button data-inbox-open="${escapeAula(item.id)}">Læs besked</button>${!item.archived && item.read?`<button data-inbox-action="unread" data-inbox-id="${escapeAula(item.id)}">Markér ulæst</button>`:''}<button data-inbox-action="${item.archived?'restore':'archive'}" data-inbox-id="${escapeAula(item.id)}">${item.archived?'Gendan':'Arkivér hos mig'}</button></div></article>`;}).join('')}
      ${!items.length && !this.inboxError ? `<div class="empty">${!this.inboxData?'Henter din indbakke…':this.inboxFilter==='archive'?'Dit arkiv er tomt.':this.inboxFilter==='unread'?'Du har ingen ulæste beskeder.':'Din indbakke er tom.'}</div>`:''}
      <p class="muted">${this.inboxData?.last_scan?'Seneste automatiske kontrol: '+escapeAula(aulaDate(this.inboxData.last_scan)):''}</p>`;
  }
  async updateInbox(id, action, render = true) {
    if (this.inboxUpdating) return false;
    this.inboxUpdating = true;
    const owner = this._hass;
    this.loadGeneration = (this.loadGeneration || 0) + 1; // Discard older polls.
    try {
      const data = await owner.callApi('POST', 'aula_bridge/inbox', {id, action});
      if (owner.user?.id !== this._hass.user?.id) return false;
      this.inboxData = data; this.inboxError = null;
      if (render) this.render();
      return true;
    } catch {
      if (owner.user?.id !== this._hass.user?.id) return false;
      this.inboxError = 'Ændringen kunne ikke gemmes. Prøv igen; beskeden er ikke fjernet.';
      if (render) this.render();
      return false;
    } finally { this.inboxUpdating = false; }
  }
  async readInbox(id) {
    const item = this.inboxData?.items.find(item=>item.id===id);
    if (!item) return;
    const r = item.result || {};
    const saved = await this.updateInbox(id, 'read', false);
    if (!saved) { this.render(); return; }
    this.reader(r.title || 'Aula · kræver gennemlæsning',
      `<p class="text">${escapeAula(r.summary || 'Kilden kunne ikke analyseres sikkert. Læs den i Aula.')}</p>
      ${(r.actions || []).length?'<h3>Det skal I gøre</h3>':''}${(r.actions || []).map(a=>`<p class="text">${escapeAula(a.text)}${a.deadline?`<br><strong>Frist: ${escapeAula(a.deadline)}</strong>`:''}</p>`).join('')}
      ${(r.uncertainties || []).length?'<h3>Kræver afklaring</h3>':''}${(r.uncertainties || []).map(t=>`<p class="text">${escapeAula(t)}</p>`).join('')}
      <p class="muted">${escapeAula(item.source_id)}${item.test?' · Prøveanalyse':''}</p><p class="muted">Kun markeret læst hos dig.</p>`);
  }
  async call(name, args) {
    const result = await this._hass.callApi('POST','aula_bridge/call',{name, arguments:args});
    if (result?.error || result?.ok === false) throw new Error('source_error');
    return result;
  }
  section(key) { return this.snapshot?.sections?.[key] || {status:'unknown',data:null}; }
  status(key) {
    const section = this.section(key);
    if (section.status === 'unsupported') return '<div class="empty">Ikke tilgængelig hos jeres institution.</div>';
    if (section.status === 'error') return `<div class="warning">Kunne ikke opdatere denne datakilde.${section.stale ? ` Viser ældre data fra ${escapeAula(aulaDate(section.fetched_at))}.` : ''}</div>`;
    return '';
  }
  data(value, depth = 0) {
    if (value == null) return '<span class="muted">Ingen oplysninger</span>';
    if (typeof value !== 'object') {
      if (typeof value === 'boolean') return value ? 'Ja' : 'Nej';
      return `<span class="text">${escapeAula(value)}</span>`;
    }
    if (Array.isArray(value)) return value.length ? value.map(item=>`<div class="record">${this.data(item,depth+1)}</div>`).join('') : '<div class="empty">Ingen poster returneret.</div>';
    const labels = {title:'Titel',subject:'Emne',content:'Indhold',text:'Tekst',body:'Besked',sender:'Afsender',senderName:'Afsender',author:'Afsender',date:'Dato',startDateTime:'Start',endDateTime:'Slut',institution:'Institution',name:'Navn',isUnread:'Ulæst',messages:'Beskeder',attachments:'Bilag',filename:'Filnavn',responseDeadline:'Svarfrist',description:'Beskrivelse',status:'Status'};
    return Object.entries(value).filter(([key])=>!['tokens','path','url','userId','createdDateTime','oldStartDateTime','oldEndDateTime'].includes(key)).map(([key,item])=>{
      if (item == null || item === '') return '';
      if (typeof item === 'object') return `<details ${depth<1?'open':''}><summary>${escapeAula(labels[key]||key)}</summary>${this.data(item,depth+1)}</details>`;
      const formatted = /DateTime$|^date$|timestamp/i.test(key) ? aulaDate(item) || item : item;
      return `<div class="field"><span class="label">${escapeAula(labels[key]||key)}</span>${this.data(formatted,depth+1)}</div>`;
    }).join('');
  }
  calendar() {
    const all = aulaArray(this.section('calendar').data);
    const rows = Array.isArray(all) ? all.filter(x => (this.lessons || x.type !== 'lesson') && (this.child==='all'||x.belongsToProfiles?.includes(Number(this.child)))).sort((a,b)=>new Date(a.startDateTime)-new Date(b.startDateTime)) : [];
    return `<div class="section-title"><h2>De næste 30 dage</h2><label class="toggle"><input id="lessons" type="checkbox" ${this.lessons?'checked':''}> Vis skoleskema</label></div>${this.status('calendar')}${rows.length ? rows.map(x=>{
      const names = this.snapshot.manifest.children.filter(c=>x.belongsToProfiles?.includes(c.id)).map(c=>c.name.split(' ')[0]).join(' · ');
      return `<article class="event"><div class="when">${escapeAula(aulaDate(x.startDateTime))}${!x.allDay?' – '+escapeAula(new Date(x.endDateTime).toLocaleTimeString('da-DK',{timeZone:'Europe/Copenhagen',hour:'2-digit',minute:'2-digit'})):''}</div><h3>${escapeAula(x.title)}</h3><span class="pill">${escapeAula(names||'Familien')}</span>${x.responseRequired?'<span class="pill urgent">Kræver svar</span>':''}${x.responseDeadline?`<p>Svar senest ${escapeAula(aulaDate(x.responseDeadline))}</p>`:''}<p class="muted">${escapeAula(x.primaryResource?.name||'')}</p></article>`;
    }).join(''):'<div class="empty">Ingen kalenderposter i det valgte filter. Skoleskema kan vises ovenfor.</div>'}`;
  }
  messages() {
    const source = this.extraMessages || this.section('messages').data;
    const threads = aulaArray(source);
    return `<div class="section-title"><h2>Beskeder</h2><span class="muted">Side ${this.page+1}</span></div>${this.status('messages')}${Array.isArray(threads)&&threads.length?threads.map(x=>{
      const id=x.id??x.threadId; const subject=x.subject||x.title||'Besked';
      return `<button class="message" data-thread="${escapeAula(id)}"><div><h3>${escapeAula(subject)}</h3><p class="muted">${escapeAula(x.lastMessage?.text||x.latestMessage?.text||x.preview||'Åbn samtalen for at læse indholdet.')}</p></div><span>→</span></button>`;
    }).join(''):'<div class="empty">Ingen beskeder returneret.</div>'}<div class="paging"><button id="prev" ${this.page===0?'disabled':''}>Nyere</button><button id="next" ${source?.hasMorePages===false?'disabled':''}>Ældre</button></div><p class="muted">20 samtaler pr. side. Dette er ikke en samlet optælling af hele indbakken.</p>`;
  }
  posts() {
    const posts = aulaArray(this.extraPosts || this.section('posts').data);
    return `<h2>Opslag fra skole og dagpleje</h2>${this.status('posts')}${Array.isArray(posts)?posts.map(x=>`<article><div class="when">${escapeAula(aulaDate(x.date))} · ${escapeAula(x.institution||'')}</div><h3>${escapeAula(x.title)}</h3><p class="text">${escapeAula(x.content)}</p><p class="muted">${escapeAula(x.author)}</p>${(x.attachments||[]).map((a,i)=>`<button data-post-file="${escapeAula(x.id)}" data-index="${i}">Bilag · ${escapeAula(a.name||'Åbn')}</button>`).join('')}</article>`).join(''):this.data(posts)}<button id="older-posts">Hent 20 ældre opslag</button>`;
  }
  sources() {
    return `<h2>Datakilder og dækning</h2><p class="muted">Status er pr. kilde. En fejl betyder ikke, at der ingen data er. Ingen automatiske ændringer i Aula.</p>${Object.entries(this.snapshot.sections).map(([key,section])=>`<article class="source"><div><h3>${escapeAula(aulaLabels[key]||key)}</h3><p class="muted">${escapeAula(section.coverage||'')}${section.fetched_at?' · '+escapeAula(aulaDate(section.fetched_at)):''}</p></div><span class="pill ${section.status==='error'?'urgent':''}">${escapeAula({ok:'Hentet',unsupported:'Ikke tilgængelig',error:'Fejl'}[section.status]||section.status)}</span></article>`).join('')}<details><summary>Profiler og institutioner</summary>${this.data(this.section('profiles').data)}</details><details id="tools-details"><summary>Alle læse-endpoints</summary><div id="tool-list">Åbn for at hente listen.</div></details>`;
  }
  render() {
    if (!this.shadowRoot) return;
    const snapshot = this.snapshot;
    const tabs = [['indbakke',`Indbakke${this.inboxData?.unread?' · '+Number(this.inboxData.unread):''}`],['overblik','Overblik'],['beskeder','Beskeder'],['opslag','Opslag'],['planer','Planer og lektier'],['fremmode','Fremmøde'],['kilder','Datakilder']];
    let body = '';
    if (!snapshot) body = `<div class="empty">${escapeAula(this.error||'Henter Aula…')}</div>`;
    else if (this.tab==='indbakke') body = this.inbox();
    else if (this.tab==='overblik') body = `${this.calendar()}<h2>Notifikationer</h2>${this.status('notifications')}${this.data(this.section('notifications').data)}`;
    else if (this.tab==='beskeder') body = this.messages();
    else if (this.tab==='opslag') body = this.posts();
    else if (this.tab==='planer') body = ['ugeplan','opgaver','ugebrev','huskelisten','lektier'].map(key=>`<article><h2>${aulaLabels[key]}</h2>${this.status(key)}${this.section(key).data!=null?this.data(this.section(key).data):''}</article>`).join('');
    else if (this.tab==='fremmode') body = ['presence','presence_templates'].map(key=>`<article><h2>${aulaLabels[key]}</h2>${this.status(key)}${this.data(this.section(key).data)}</article>`).join('');
    else body = this.sources();
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;color:var(--primary-text-color);font-family:var(--paper-font-body1_-_font-family,system-ui);--accent:#b7c9a0}
      .inbox-filters,.inbox-actions{display:flex;gap:8px;flex-wrap:wrap}.inbox-filters button[aria-pressed="true"]{background:var(--accent);color:#1d2919}.inbox-item.unread{border-left:3px solid var(--accent)}
      *{box-sizing:border-box} .shell{max-width:1400px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:24px}.eyebrow{letter-spacing:.18em;text-transform:uppercase;color:var(--secondary-text-color);font-size:11px}h1{font-size:38px;letter-spacing:-.04em;margin:6px 0}h2{font-size:20px;font-weight:600;margin:18px 0}h3{font-size:15px;margin:5px 0}.muted,.when{color:var(--secondary-text-color);font-size:12px;line-height:1.6}.text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.65}.header-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}button,select{font:inherit;background:var(--card-background-color);color:var(--primary-text-color);border:1px solid var(--divider-color);border-radius:10px;padding:10px 14px;cursor:pointer}button:hover{border-color:var(--accent)}button:disabled{opacity:.4;cursor:default}nav{display:flex;gap:6px;overflow:auto;padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--divider-color)}nav button{white-space:nowrap;border:0;background:transparent;font-size:13px}nav button.active{background:var(--accent);color:#1d2919}.section-title,.source{display:flex;align-items:center;justify-content:space-between;gap:16px}.toggle{display:flex;align-items:center;gap:7px;font-size:13px;white-space:nowrap}article,.record{background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:14px;padding:18px;margin:10px 0}.record{border-radius:8px;padding:12px;background:transparent}.event{border-left:3px solid var(--accent)}.pill{display:inline-block;font-size:11px;border-radius:20px;background:var(--secondary-background-color);padding:5px 9px;margin:5px 4px 0 0}.urgent{background:#6f4628;color:#fff1d9}.warning{padding:14px;border:1px solid #9a663b;border-radius:10px;color:var(--primary-text-color);font-size:13px;margin:8px 0}.empty{padding:28px 14px;text-align:center;color:var(--secondary-text-color);font-size:14px}.message{display:flex;justify-content:space-between;align-items:center;width:100%;text-align:left;margin:10px 0;padding:18px}.message p{max-width:850px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.paging{display:flex;gap:10px;margin-top:18px}details{padding:10px 0}summary{cursor:pointer;font-size:13px;color:var(--secondary-text-color)}.field{display:flex;align-items:baseline;gap:12px;padding:5px 0;border-bottom:1px solid var(--divider-color)}.label{min-width:110px;font-size:11px;color:var(--secondary-text-color);overflow-wrap:anywhere}.reader{position:fixed;inset:0;background:#0009;z-index:100;display:flex;justify-content:flex-end}.reader-panel{width:min(780px,100%);height:100%;overflow:auto;background:var(--primary-background-color);padding:28px}.reader-head{display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--primary-background-color);padding:10px 0}.tools{display:grid;gap:10px}textarea{width:100%;min-height:100px;border:1px solid var(--divider-color);background:var(--card-background-color);color:var(--primary-text-color);padding:12px;border-radius:8px}.toast{padding:12px 0;font-size:13px;color:var(--secondary-text-color)}@media(max-width:700px){.shell{padding:16px}header{align-items:flex-start;flex-direction:column}h1{font-size:30px}.section-title{align-items:flex-start;flex-direction:column;gap:0}.field{display:block}.label{display:block}article{padding:14px}.reader-panel{padding:16px}}
      </style><div class="shell"><header><div><div class="eyebrow">Familien · Aula</div><h1>Skole & hverdag</h1><div class="muted">${snapshot?'Senest hentet '+escapeAula(aulaDate(snapshot.fetched_at)):'Forbinder til Aula'}</div></div><div class="header-actions"><select id="child" aria-label="Kalenderfilter"><option value="all">Kalender: begge børn</option>${(snapshot?.manifest?.children||[]).map(c=>`<option value="${c.id}" ${this.child===String(c.id)?'selected':''}>Kalender: ${escapeAula(c.name.split(' ')[0])}</option>`).join('')}</select><button id="refresh">Opdatér</button></div></header>${this.error||this.available===false?`<div class="warning">${escapeAula(this.error||'Forbindelsen er afbrudt. Data nedenfor kan være forældede.')}</div>`:''}<nav>${tabs.map(([id,label])=>`<button data-tab="${id}" class="${this.tab===id?'active':''}">${label}</button>`).join('')}</nav><main>${body}</main><div class="toast">${escapeAula(this.notice||'')}</div>${this.lastAttachment?'<button id="read-pdf">Læs seneste PDF-bilag som tekst</button>':''}</div>`;
    this.bind();
  }
  bind() {
    this.shadowRoot.querySelectorAll('[data-inbox-filter]').forEach(el=>el.onclick=()=>{this.inboxFilter=el.dataset.inboxFilter;this.render();});
    this.shadowRoot.querySelectorAll('[data-inbox-open]').forEach(el=>el.onclick=()=>this.readInbox(el.dataset.inboxOpen));
    this.shadowRoot.querySelectorAll('[data-inbox-action]').forEach(el=>el.onclick=async()=>{el.disabled=true;await this.updateInbox(el.dataset.inboxId,el.dataset.inboxAction);});
    this.shadowRoot.querySelectorAll('[data-tab]').forEach(el=>el.onclick=()=>{this.tab=el.dataset.tab;this.render();});
    this.shadowRoot.querySelector('#child').onchange=e=>{this.child=e.target.value;this.render();};
    this.shadowRoot.querySelector('#refresh').onclick=async()=>{try{await this._hass.callApi('POST','aula_bridge/refresh',{});await this.load();}catch{this.notice='Opdatering mislykkedes.';this.render();}};
    const pdf=this.shadowRoot.querySelector('#read-pdf');if(pdf)pdf.onclick=async()=>{try{const result=await this.call('aula.utils.extract_pdf_text',{attachment_id:this.lastAttachment.attachment_id});this.reader('PDF · '+this.lastAttachment.filename,this.data(result));}catch{this.notice='PDF-teksten kunne ikke læses. Filen skal være en PDF, og bilaget udløber efter en time.';this.render();}};
    const lessons=this.shadowRoot.querySelector('#lessons'); if(lessons)lessons.onchange=e=>{this.lessons=e.target.checked;this.render();};
    this.shadowRoot.querySelectorAll('[data-thread]').forEach(el=>el.onclick=()=>this.readThread(Number(el.dataset.thread)));
    for(const [id,delta] of [['prev',-1],['next',1]]){const el=this.shadowRoot.querySelector('#'+id);if(el)el.onclick=async()=>{try{const page=Math.max(0,this.page+delta);this.extraMessages=await this.call('aula.messages.list_threads',{page});this.page=page;this.render();}catch{this.notice='Kunne ikke hente beskedsiden.';this.render();}};}
    const older=this.shadowRoot.querySelector('#older-posts');if(older)older.onclick=async()=>{try{this.postIndex=(this.postIndex||0)+20;const result=await this.call('aula.posts.list',{index:this.postIndex,limit:20});this.extraPosts=[...aulaArray(this.extraPosts||this.section('posts').data),...aulaArray(result)];this.render();}catch{this.notice='Kunne ikke hente ældre opslag.';this.render();}};
    this.shadowRoot.querySelectorAll('[data-post-file]').forEach(el=>el.onclick=async()=>{const posts=aulaArray(this.extraPosts||this.section('posts').data);const post=posts.find(p=>p.id===Number(el.dataset.postFile));const file=post?.attachments?.[Number(el.dataset.index)];if(file)await this.attachment('aula.posts.get_attachment',{postId:post.id,url:file.url,filename:file.name});});
    const details=this.shadowRoot.querySelector('#tools-details');if(details)details.ontoggle=()=>{if(details.open)this.tools();};
  }
  reader(title, html) {
    this.shadowRoot.querySelector('.reader')?.remove();
    const panel=document.createElement('div');panel.className='reader';panel.innerHTML=`<div class="reader-panel"><div class="reader-head"><h2>${escapeAula(title)}</h2><button id="close-reader">Luk</button></div>${html}</div>`;this.shadowRoot.append(panel);panel.querySelector('#close-reader').onclick=()=>{panel.remove();this.render();};return panel;
  }
  async readThread(threadId) {
    if(!Number.isSafeInteger(threadId))return;
    const panel=this.reader('Besked','<div class="empty">Henter samtalen…</div>');
    try{const result=await this.call('aula.messages.get_thread',{threadId});panel.remove();const html=this.data(result);const view=this.reader(result.subject||'Samtale',html+'<button id="thread-file">Hent bilag</button><label> Bilag nr. <input id="attachment-index" type="number" min="1" value="1" style="width:60px"></label>');view.querySelector('#thread-file').onclick=()=>this.attachment('aula.messages.get_attachment',{threadId,attachmentIndex:Number(view.querySelector('#attachment-index').value)-1});}
    catch{panel.remove();this.reader('Beskeden kunne ikke hentes','<p>Følsomme samtaler kan kræve et nyt MitID-login. Kontroller datakilden og prøv igen.</p>');}
  }
  async attachment(name,args) {
    try{
      const file=await this.call(name,args);
      if(!file.attachment_id)throw new Error();
      const response=await this._hass.fetchWithAuth('/api/aula_bridge/files/'+file.attachment_id);
      if(!response.ok)throw new Error();
      const blob=await response.blob();const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=file.filename||'bilag';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),30000);
      this.lastAttachment=file;this.notice='Bilaget er hentet. PDF-tekst kan åbnes fra knappen nederst på dashboardet.';if(!this.shadowRoot.querySelector('.reader'))this.render();
    }catch{this.notice='Bilaget kunne ikke hentes. Kontroller at bilagsnummer og adgang er korrekte.';this.render();}
  }
  async tools() {
    const target=this.shadowRoot.querySelector('#tool-list');
    try{
      const tools=await this._hass.callApi('GET','aula_bridge/tools');
      target.innerHTML=tools.map((tool,i)=>`<details><summary>${escapeAula(tool.title||tool.name)}</summary><p class="muted">${escapeAula(tool.name)} · ${escapeAula(tool.description)}</p><textarea id="args-${i}" aria-label="Argumenter"></textarea><button data-tool="${i}">Hent data</button><div id="result-${i}"></div></details>`).join('');
      tools.forEach((tool,i)=>{const input=target.querySelector('#args-'+i);const args={};for(const key of tool.inputSchema?.required||[]){if(key==='childIds'||key==='profileIds')args[key]=this.snapshot.manifest.children.map(c=>c.id);else if(key==='institutionCodes')args[key]=[...new Set(this.snapshot.manifest.children.map(c=>c.institution.code))];}input.value=JSON.stringify(args,null,2);});
      target.querySelectorAll('[data-tool]').forEach(button=>button.onclick=async()=>{const i=Number(button.dataset.tool);const result=target.querySelector('#result-'+i);try{result.innerHTML='<p class="muted">Henter…</p>';const data=await this.call(tools[i].name,JSON.parse(target.querySelector('#args-'+i).value));result.innerHTML=this.data(data);}catch{result.innerHTML='<p>Kunne ikke hente data. Kontroller argumenter og datakildens adgang.</p>';}});
    }catch{target.textContent='Listen over læse-endpoints kunne ikke hentes.';}
  }
}
customElements.define('aula-dashboard-card',AulaDashboardCard);
window.customCards=window.customCards||[];
window.customCards.push({type:'aula-dashboard-card',name:'Aula dashboard',description:'Separat familieoversigt med alle tilgængelige Aula-læsekilder.'});

