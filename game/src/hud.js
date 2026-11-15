// The DOM HUD: vitals, ammunition, money, the round clock and score, a kill feed, round
// banners, the plant/defuse progress bar, the buy menu, a live minimap, and the start /
// pause / match-end overlays. It never touches the simulation — main.js pushes numbers
// in, and reads the play and buy callbacks out.
import { WORLD_BOUNDS } from './map.js';

export const BUY_ITEMS = [
  { id: 'raptor', key: '1', name: 'Raptor SMG', price: 1400, note: 'Fast, loose, close-range' },
  { id: 'kr7', key: '2', name: 'KR-7 Carbine', price: 2700, note: 'The all-round rifle' },
  { id: 'piercer', key: '3', name: 'Piercer Long Rifle', price: 4300, note: 'One shot, scoped' },
  { id: 'armor', key: '4', name: 'Kevlar + Helmet', price: 1000, note: 'Soaks half of every hit' },
  { id: 'frag', key: '5', name: 'Frag Grenade', price: 300, note: 'Clears a corner' },
  { id: 'flash', key: '6', name: 'Flash Charge', price: 200, note: 'Blinds a held angle' },
  { id: 'smoke', key: '7', name: 'Smoke Canister', price: 300, note: 'Cuts a sightline for 13 s' },
];

function el(id) {
  return document.getElementById(id);
}

export function createHud(callbacks) {
  const hud = el('hud');
  const healthNum = el('health-num');
  const healthFill = el('health-fill');
  const armorNum = el('armor-num');
  const money = el('money');
  const ammoBox = el('ammo-box');
  const ammoMag = el('ammo-mag');
  const ammoReserve = el('ammo-reserve');
  const weaponName = el('weapon-name');
  const timer = el('timer');
  const scoreW = el('score-w');
  const scoreJ = el('score-j');
  const aliveW = el('alive-w');
  const aliveJ = el('alive-j');
  const bombStatus = el('bomb-status');
  const killfeed = el('killfeed');
  const banner = el('banner');
  const bannerTitle = el('banner-title');
  const bannerSub = el('banner-sub');
  const prompt = el('prompt');
  const progress = el('progress');
  const progressFill = el('progress-fill');
  const progressLabel = el('progress-label');
  const crosshair = el('crosshair');
  const hitmarker = el('hitmarker');
  const vignette = el('damage-vignette');
  const flashOverlay = el('flash-overlay');
  const scope = el('scope');
  const overlay = el('overlay');
  const overlayTitle = el('overlay-title');
  const overlayCopy = el('overlay-copy');
  const overlayStats = el('overlay-stats');
  const playButton = el('play');
  const buymenu = el('buymenu');
  const buyGrid = el('buy-grid');
  const buyMoney = el('buy-money');
  const buyRound = el('buy-round');
  const minimap = el('minimap');
  const mapCtx = minimap.getContext('2d');

  let bannerTimer = null;
  let hitTimer = null;
  playButton.addEventListener('click', () => callbacks.onPlay());

  const buyButtons = new Map();
  for (const item of BUY_ITEMS) {
    const button = document.createElement('button');
    button.className = 'buy-item';
    button.type = 'button';
    button.innerHTML = `<span><b>${item.key}</b> · ${item.name}<small>${item.note}</small></span><span class="price">$${item.price}</span>`;
    button.addEventListener('click', () => callbacks.onBuy(item.id));
    buyGrid.appendChild(button);
    buyButtons.set(item.id, button);
  }

  function pips(alive, total) {
    return '●'.repeat(alive) + '○'.repeat(Math.max(0, total - alive));
  }

  return {
    showHud() {
      hud.hidden = false;
    },
    setHealth(health, armor) {
      healthNum.textContent = String(Math.ceil(health));
      healthFill.style.width = `${Math.max(0, Math.min(100, health))}%`;
      healthFill.className = health <= 30 ? 'low' : '';
      armorNum.textContent = String(Math.ceil(armor));
    },
    setAmmo(mag, reserve, name, reloading, isGrenade) {
      ammoMag.textContent = isGrenade ? String(reserve) : String(mag);
      ammoReserve.textContent = isGrenade ? '' : `/ ${reserve}`;
      weaponName.textContent = reloading ? `${name} — RELOADING` : name;
      ammoBox.className = `${mag === 0 && !isGrenade ? 'empty' : ''} ${reloading ? 'reloading' : ''}`;
    },
    setMoney(value) {
      money.textContent = `$${value}`;
      buyMoney.textContent = `$${value}`;
    },
    setTimer(seconds, urgent) {
      const s = Math.max(0, Math.ceil(seconds));
      timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      timer.className = urgent ? 'urgent' : '';
    },
    setScore(w, j, aliveCountW, aliveCountJ) {
      scoreW.textContent = String(w);
      scoreJ.textContent = String(j);
      aliveW.textContent = pips(aliveCountW, 5);
      aliveJ.textContent = pips(aliveCountJ, 5);
    },
    setBombStatus(text) {
      if (text) {
        bombStatus.hidden = false;
        bombStatus.textContent = text;
      } else {
        bombStatus.hidden = true;
      }
    },
    killfeed(killerName, killerTeam, victimName, victimTeam, headshot) {
      const row = document.createElement('div');
      row.innerHTML = `<span class="${killerTeam === 'wardens' ? 'w' : 'j'}">${killerName}</span> ${headshot ? '⌖' : '▸'} <span class="${victimTeam === 'wardens' ? 'w' : 'j'}">${victimName}</span>`;
      killfeed.prepend(row);
      while (killfeed.children.length > 5) killfeed.lastChild.remove();
      setTimeout(() => {
        row.style.opacity = '0';
        setTimeout(() => row.remove(), 450);
      }, 4200);
    },
    banner(title, sub, holdMs = 2600) {
      bannerTitle.textContent = title;
      bannerSub.textContent = sub ?? '';
      banner.className = 'on';
      if (bannerTimer) clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => {
        banner.className = '';
      }, holdMs);
    },
    prompt(html) {
      if (html) {
        prompt.hidden = false;
        prompt.innerHTML = html;
      } else {
        prompt.hidden = true;
      }
    },
    progress(frac, label) {
      if (frac === null) {
        progress.hidden = true;
        return;
      }
      progress.hidden = false;
      progressLabel.textContent = label;
      progressFill.style.width = `${Math.round(frac * 100)}%`;
    },
    hitMarker(kill) {
      hitmarker.className = kill ? 'on kill' : 'on';
      if (hitTimer) clearTimeout(hitTimer);
      hitTimer = setTimeout(() => {
        hitmarker.className = '';
      }, kill ? 260 : 110);
    },
    crosshairSpread(px) {
      crosshair.style.setProperty('--gap', `${Math.round(px)}px`);
    },
    damageFlash(strength) {
      vignette.style.opacity = String(Math.min(1, strength));
    },
    decayDamage(dt) {
      const current = Number(vignette.style.opacity || 0);
      if (current > 0) vignette.style.opacity = String(Math.max(0, current - dt * 1.6));
    },
    setFlash(strength) {
      flashOverlay.style.opacity = String(Math.min(1, strength));
    },
    setScope(on) {
      scope.hidden = !on;
      crosshair.style.visibility = on ? 'hidden' : 'visible';
    },
    showBuy(round, moneyValue, owned) {
      buymenu.hidden = false;
      buyRound.textContent = String(round);
      this.setMoney(moneyValue);
      for (const item of BUY_ITEMS) {
        const button = buyButtons.get(item.id);
        const isOwned = owned.has(item.id);
        button.className = `buy-item ${isOwned ? 'owned' : ''} ${!isOwned && moneyValue < item.price ? 'cant' : ''}`;
        button.querySelector('.price').textContent = isOwned ? 'OWNED' : `$${item.price}`;
      }
    },
    refreshBuy(moneyValue, owned) {
      if (!buymenu.hidden) this.showBuy(Number(buyRound.textContent), moneyValue, owned);
    },
    hideBuy() {
      buymenu.hidden = true;
    },
    buyOpen() {
      return !buymenu.hidden;
    },
    showOverlay(mode, statsText) {
      overlay.hidden = false;
      if (mode === 'start') {
        overlayTitle.innerHTML = 'SABLE <span>YARD</span>';
        overlayCopy.textContent = 'A tactical FPS in a freight depot at dusk. Wardens hold the yard; Jackals bring the charge. First to five rounds takes the match.';
        overlayStats.textContent = '';
        playButton.textContent = 'Click to play';
      } else if (mode === 'paused') {
        overlayTitle.innerHTML = 'PAUSED';
        overlayCopy.textContent = 'The yard waits. Click to jump back in.';
        overlayStats.textContent = statsText ?? '';
        playButton.textContent = 'Click to resume';
      } else if (mode === 'end') {
        overlayTitle.innerHTML = statsText && statsText.startsWith('WARDENS') ? 'WARDENS <span>WIN</span>' : statsText && statsText.startsWith('JACKALS') ? 'JACKALS <span>WIN</span>' : 'MATCH <span>OVER</span>';
        overlayCopy.textContent = 'The match is settled. Click to play another.';
        overlayStats.textContent = statsText ?? '';
        playButton.textContent = 'Play again';
      }
    },
    hideOverlay() {
      overlay.hidden = true;
    },
    overlayOpen() {
      return !overlay.hidden;
    },
    // The minimap: collider footprints painted once to an offscreen canvas, then team
    // dots per frame (teammates and the player; enemies only when they fire — handled by
    // main passing only what the player may know).
    paintMinimapBase(footprints) {
      const base = document.createElement('canvas');
      base.width = minimap.width;
      base.height = minimap.height;
      const bctx = base.getContext('2d');
      const sx = minimap.width / (WORLD_BOUNDS.maxX - WORLD_BOUNDS.minX);
      const sz = minimap.height / (WORLD_BOUNDS.maxZ - WORLD_BOUNDS.minZ);
      bctx.fillStyle = 'rgba(35,44,56,0.9)';
      bctx.fillRect(0, 0, base.width, base.height);
      bctx.fillStyle = 'rgba(236,231,219,0.28)';
      for (const f of footprints) {
        const w = (f.maxX - f.minX) * sx;
        const h = (f.maxZ - f.minZ) * sz;
        if (w > base.width * 0.9) continue; // the ground slab
        bctx.fillRect((f.minX - WORLD_BOUNDS.minX) * sx, (f.minZ - WORLD_BOUNDS.minZ) * sz, w, h);
      }
      bctx.fillStyle = '#ffb347';
      bctx.font = '700 11px system-ui';
      bctx.fillText('A', (-22 - WORLD_BOUNDS.minX) * sx - 3, (-14 - WORLD_BOUNDS.minZ) * sz + 4);
      bctx.fillText('B', (21 - WORLD_BOUNDS.minX) * sx - 3, (14 - WORLD_BOUNDS.minZ) * sz + 4);
      this._mapBase = base;
    },
    drawMinimap(playerPos, playerYaw, dots) {
      if (!this._mapBase) return;
      const sx = minimap.width / (WORLD_BOUNDS.maxX - WORLD_BOUNDS.minX);
      const sz = minimap.height / (WORLD_BOUNDS.maxZ - WORLD_BOUNDS.minZ);
      mapCtx.clearRect(0, 0, minimap.width, minimap.height);
      mapCtx.drawImage(this._mapBase, 0, 0);
      for (const dot of dots) {
        mapCtx.fillStyle = dot.color;
        mapCtx.beginPath();
        mapCtx.arc((dot.x - WORLD_BOUNDS.minX) * sx, (dot.z - WORLD_BOUNDS.minZ) * sz, dot.r ?? 2.4, 0, Math.PI * 2);
        mapCtx.fill();
      }
      // The player's view wedge.
      const px = (playerPos.x - WORLD_BOUNDS.minX) * sx;
      const pz = (playerPos.z - WORLD_BOUNDS.minZ) * sz;
      const fx = -Math.sin(playerYaw);
      const fz = -Math.cos(playerYaw);
      mapCtx.strokeStyle = 'rgba(236,231,219,0.8)';
      mapCtx.beginPath();
      mapCtx.moveTo(px, pz);
      mapCtx.lineTo(px + fx * 12 - fz * 5, pz + fz * 12 + fx * 5);
      mapCtx.moveTo(px, pz);
      mapCtx.lineTo(px + fx * 12 + fz * 5, pz + fz * 12 - fx * 5);
      mapCtx.stroke();
      mapCtx.fillStyle = '#ece7db';
      mapCtx.beginPath();
      mapCtx.arc(px, pz, 3, 0, Math.PI * 2);
      mapCtx.fill();
    },
  };
}
