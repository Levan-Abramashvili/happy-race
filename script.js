// Ждём полной загрузки DOM
document.addEventListener('DOMContentLoaded', function() {
  const canvas = document.getElementById('game');
  
  // Проверяем, что canvas найден
  if (!canvas) {
    console.error('Canvas не найден!');
    return;
  }
  
  const ctx = canvas.getContext('2d');
  
  if (!ctx) {
    console.error('Не удалось получить 2D контекст!');
    return;
  }
  
  const W = canvas.width;
  const H = canvas.height;
  
  console.log('Canvas загружен:', W, 'x', H);

  // Дорога (центрируется по ширине поля).
  // ROAD_W кратно LANES, поэтому границы полос ложатся на целые пиксели — разметка ровная
  const LANES = 3;
  const ROAD_W = 330;
  const ROAD_X = (W - ROAD_W) / 2;
  const LANE_W = ROAD_W / LANES;

  // Игрок
  const player = {
    w: 40, h: 70,
    x: ROAD_X + ROAD_W/2 - 20,
    y: H - 170,
    speed: 0,
    maxSpeed: 6,
    color: '#ff3b3b'
  };

  // Полицейская машина — декорация, едет за игроком
  const police = {
    w: 44, h: 62,
    x: player.x,
    y: player.y + player.h + 12
  };

  // Состояние игры
  let enemies = [];
  let trees = [];
  let score = 0;
  let best = +localStorage.getItem('racer_best') || 0;
  let speed = 4;
  let gameOver = false;
  let paused = false;
  let started = false;
  let frame = 0;
  let shake = 0;

  // Бонус-таран
  let bonus = null;
  let ramFrames = 0;
  const RAM_DURATION = 300; // ~5 секунд при 60 FPS

  // Собственная скорость всех машин одинакова: они не сближаются со временем,
  // поэтому достаточно проверить перекрытие полос при спавне
  const ENEMY_OWN = 1.4;

  // Разметка: общий сдвиг + постоянный период — полосы всегда ровные
  let roadOffset = 0;
  const DASH_H = 34;      // длина штриха
  const DASH_PERIOD = 68; // штрих + промежуток

  // Инициализация деревьев
  for (let y = 0; y < H; y += 80) {
    trees.push({ y, side: 'left' });
    trees.push({ y: y + 40, side: 'right' });
  }

  // Ввод. Используем e.code (физическая клавиша), а не e.key —
  // так управление работает в любой раскладке, включая русскую
  const keys = {};
  document.addEventListener('keydown', e => {
    const code = e.code;
    if (code === 'ArrowLeft' || code === 'KeyA') { keys.left = true; e.preventDefault(); }
    if (code === 'ArrowRight' || code === 'KeyD') { keys.right = true; e.preventDefault(); }
    if (code === 'Space') { paused = !paused; e.preventDefault(); }
    if (code === 'Enter' && gameOver) restart();
    if (!started && !gameOver) started = true;
  });
  document.addEventListener('keyup', e => {
    const code = e.code;
    if (code === 'ArrowLeft' || code === 'KeyA') keys.left = false;
    if (code === 'ArrowRight' || code === 'KeyD') keys.right = false;
  });

  // Сенсорное управление
  let touchX = null;
  canvas.addEventListener('touchstart', e => {
    touchX = e.touches[0].clientX;
    if (!started) started = true;
    if (gameOver) restart();
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    const x = e.touches[0].clientX;
    if (touchX !== null) {
      const dx = x - touchX;
      player.x += dx * 0.5;
      touchX = x;
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchend', () => touchX = null);

  function spawnEnemy() {
    const colors = ['#3b82f6', '#f59e0b', '#10b981', '#a855f7', '#ec4899', '#fbbf24'];
    const ENEMY_W = 40;
    const ENEMY_H = 70;
    const GAP = 30; // минимальный зазор между машинами
    const spawnY = -80;

    // Ищем полосу, где сверху достаточно места, чтобы машины не появлялись друг в друге
    const freeLanes = [];
    for (let lane = 0; lane < LANES; lane++) {
      const blocked = enemies.some(e =>
        e.lane === lane && e.y < ENEMY_H + GAP * 2
      );
      if (!blocked) freeLanes.push(lane);
    }
    if (freeLanes.length === 0) return;

    // Перемешиваем свободные полосы, чтобы выбор оставался случайным
    for (let i = freeLanes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [freeLanes[i], freeLanes[j]] = [freeLanes[j], freeLanes[i]];
    }

    for (const lane of freeLanes) {
      // Не спавним, если это создаст «стену» из машин во всех полосах:
      // тогда игроку не останется свободной полосы, чтобы объехать
      let busyOtherLanes = 0;
      for (let l = 0; l < LANES; l++) {
        if (l === lane) continue;
        const overlaps = enemies.some(e => e.lane === l &&
          e.y < spawnY + ENEMY_H + GAP && e.y + e.h > spawnY - GAP);
        if (overlaps) busyOtherLanes++;
      }
      if (busyOtherLanes >= LANES - 1) continue; // все другие полосы заняты

      // Случайное смещение внутри полосы: машина может встать чуть левее/правее центра,
      // чтобы нельзя было проскользнуть между полосами, ничего не делая
      const maxOff = LANE_W / 2 - ENEMY_W / 2 - 2;
      const offset = (Math.random() * 2 - 1) * maxOff;
      const laneLeft = ROAD_X + lane * LANE_W;

      enemies.push({
        x: laneLeft + LANE_W / 2 - ENEMY_W / 2 + offset,
        y: spawnY,
        lane: lane,
        w: ENEMY_W, h: ENEMY_H,
        // Собственная скорость: машины не стоят, а едут вперёд
        own: ENEMY_OWN,
        color: colors[Math.floor(Math.random() * colors.length)]
      });
      return;
    }
  }

  function spawnBonus() {
    const lane = Math.floor(Math.random() * LANES);
    bonus = {
      x: ROAD_X + lane * LANE_W + LANE_W/2 - 16,
      y: -60,
      w: 32, h: 32,
      pulse: 0
    };
  }

  function drawCar(x, y, w, h, color, isPlayer = false) {
    // Тень
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x + 3, y + 5, w, h);
    
    // Кузов
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    
    // Крыша/стёкла
    ctx.fillStyle = 'rgba(20, 30, 50, 0.85)';
    ctx.fillRect(x + 5, y + 15, w - 10, 18);
    ctx.fillRect(x + 5, y + h - 28, w - 10, 14);
    
    // Фары
    ctx.fillStyle = isPlayer ? '#fff59d' : '#ffeb3b';
    if (isPlayer) {
      ctx.fillRect(x + 4, y + 2, 8, 4);
      ctx.fillRect(x + w - 12, y + 2, 8, 4);
    } else {
      ctx.fillRect(x + 4, y + h - 6, 8, 4);
      ctx.fillRect(x + w - 12, y + h - 6, 8, 4);
    }
    
    // Задние огни
    ctx.fillStyle = isPlayer ? '#b71c1c' : '#d32f2f';
    if (isPlayer) {
      ctx.fillRect(x + 4, y + h - 5, 8, 3);
      ctx.fillRect(x + w - 12, y + h - 5, 8, 3);
    } else {
      ctx.fillRect(x + 4, y + 2, 8, 3);
      ctx.fillRect(x + w - 12, y + 2, 8, 3);
    }
    
    // Колёса
    ctx.fillStyle = '#111';
    ctx.fillRect(x - 3, y + 10, 4, 14);
    ctx.fillRect(x + w - 1, y + 10, 4, 14);
    ctx.fillRect(x - 3, y + h - 24, 4, 14);
    ctx.fillRect(x + w - 1, y + h - 24, 4, 14);
  }

  function drawPolice(x, y, w, h) {
    // Тень
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x + 3, y + 5, w, h);

    // Кузов (тёмно-синий с белой полосой)
    ctx.fillStyle = '#1a2b6b';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(x, y + h * 0.4, w, h * 0.22);

    // Стёкла
    ctx.fillStyle = 'rgba(20, 30, 50, 0.85)';
    ctx.fillRect(x + 5, y + 15, w - 10, 16);
    ctx.fillRect(x + 5, y + h - 26, w - 10, 12);

    // Мигалка на крыше: попеременно красная и синяя
    const flash = Math.floor(frame / 12) % 2;
    ctx.fillStyle = flash === 0 ? '#ff1a1a' : '#222';
    ctx.fillRect(x + 6, y - 5, w/2 - 8, 6);
    ctx.fillStyle = flash === 1 ? '#1a6bff' : '#222';
    ctx.fillRect(x + w/2 + 2, y - 5, w/2 - 8, 6);
    // Свечение мигалки
    ctx.fillStyle = flash === 0 ? 'rgba(255,26,26,0.35)' : 'rgba(26,107,255,0.35)';
    ctx.beginPath();
    ctx.arc(x + w/2, y - 2, 16, 0, Math.PI * 2);
    ctx.fill();

    // Фары (спереди, сверху — едем вверх)
    ctx.fillStyle = '#fff59d';
    ctx.fillRect(x + 4, y + 2, 8, 4);
    ctx.fillRect(x + w - 12, y + 2, 8, 4);

    // Задние огни
    ctx.fillStyle = '#b71c1c';
    ctx.fillRect(x + 4, y + h - 5, 8, 3);
    ctx.fillRect(x + w - 12, y + h - 5, 8, 3);

    // Колёса
    ctx.fillStyle = '#111';
    ctx.fillRect(x - 3, y + 10, 4, 14);
    ctx.fillRect(x + w - 1, y + 10, 4, 14);
    ctx.fillRect(x - 3, y + h - 24, 4, 14);
    ctx.fillRect(x + w - 1, y + h - 24, 4, 14);
  }

  function drawBonus(b) {
    b.pulse += 0.15;
    const cx = b.x + b.w/2;
    const cy = b.y + b.h/2;
    const r = b.w/2 + Math.sin(b.pulse) * 3;

    // Свечение
    ctx.fillStyle = 'rgba(255, 215, 0, 0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
    ctx.fill();

    // Круг
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Молния
    ctx.fillStyle = '#1a1a2e';
    ctx.beginPath();
    ctx.moveTo(cx + 3, cy - r * 0.6);
    ctx.lineTo(cx - r * 0.35, cy + 2);
    ctx.lineTo(cx + 1, cy + 2);
    ctx.lineTo(cx - 3, cy + r * 0.6);
    ctx.lineTo(cx + r * 0.4, cy - 3);
    ctx.lineTo(cx - 1, cy - 3);
    ctx.closePath();
    ctx.fill();
  }

  function drawRoad() {
    // Трава
    ctx.fillStyle = '#2d5a2d';
    ctx.fillRect(0, 0, W, H);
    
    // Обочина
    ctx.fillStyle = '#4a4a4a';
    ctx.fillRect(ROAD_X - 8, 0, ROAD_W + 16, H);
    
    // Дорога
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(ROAD_X, 0, ROAD_W, H);
    
    // Крайние линии (сплошные)
    ctx.fillStyle = '#fff';
    ctx.fillRect(ROAD_X, 0, 3, H);
    ctx.fillRect(ROAD_X + ROAD_W - 3, 0, 3, H);
    
    // Разделительные полосы (равномерные, с постоянным периодом)
    ctx.fillStyle = '#fff';
    for (let y = roadOffset - DASH_PERIOD; y < H; y += DASH_PERIOD) {
      for (let i = 1; i < LANES; i++) {
        ctx.fillRect(ROAD_X + i * LANE_W - 2, y, 4, DASH_H);
      }
    }
  }

  function drawTrees() {
    for (const t of trees) {
      const x = t.side === 'left' ? 25 : W - 25;
      // Тень
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(x + 3, t.y + 3, 18, 18, 0, 0, Math.PI * 2);
      ctx.fill();
      // Крона
      ctx.fillStyle = '#1e4d1e';
      ctx.beginPath();
      ctx.arc(x, t.y, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2d7a2d';
      ctx.beginPath();
      ctx.arc(x - 4, t.y - 4, 10, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawHUD() {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(10, 10, 140, 60);
    ctx.strokeStyle = '#4cc9f0';
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, 140, 60);
    
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px Segoe UI';
    ctx.fillText('Очки: ' + score, 20, 32);
    ctx.font = '13px Segoe UI';
    ctx.fillStyle = '#ffd700';
    ctx.fillText('Рекорд: ' + best, 20, 52);
    
    // Скорость
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(W - 100, 10, 90, 30);
    ctx.strokeStyle = '#4cc9f0';
    ctx.strokeRect(W - 100, 10, 90, 30);
    ctx.fillStyle = '#4cc9f0';
    ctx.font = 'bold 13px Segoe UI';
    ctx.fillText('⚡ ' + Math.floor(speed * 20) + ' км/ч', W - 92, 30);

    // Индикатор тарана
    if (ramFrames > 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(10, 78, 140, 26);
      ctx.strokeStyle = '#ffd700';
      ctx.strokeRect(10, 78, 140, 26);
      ctx.fillStyle = '#ffd700';
      ctx.font = 'bold 13px Segoe UI';
      ctx.fillText('💥 ТАРАН: ' + Math.ceil(ramFrames / 60) + 'с', 20, 96);
    }
  }

  function drawOverlay(title, subtitle, color) {
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, 0, W, H);
    
    ctx.fillStyle = color;
    ctx.font = 'bold 42px Segoe UI';
    ctx.textAlign = 'center';
    ctx.fillText(title, W/2, H/2 - 30);
    
    ctx.fillStyle = '#fff';
    ctx.font = '18px Segoe UI';
    ctx.fillText(subtitle, W/2, H/2 + 10);
    
    ctx.fillStyle = '#4cc9f0';
    ctx.font = '14px Segoe UI';
    ctx.fillText('Очки: ' + score + '  ·  Рекорд: ' + best, W/2, H/2 + 40);
    ctx.textAlign = 'left';
  }

  function collide(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function restart() {
    enemies = [];
    score = 0;
    speed = 4;
    gameOver = false;
    paused = false;
    started = true;
    player.x = ROAD_X + ROAD_W/2 - 20;
    shake = 0;
    bonus = null;
    ramFrames = 0;
    police.x = player.x;
  }

  function update() {
    if (!started || paused || gameOver) return;
    
    frame++;
    
    // Движение игрока
    if (keys.left) player.x -= player.maxSpeed;
    if (keys.right) player.x += player.maxSpeed;
    
    // Границы дороги
    if (player.x < ROAD_X + 5) player.x = ROAD_X + 5;
    if (player.x + player.w > ROAD_X + ROAD_W - 5) player.x = ROAD_X + ROAD_W - 5 - player.w;

    // Полицейская машина плавно следует за игроком (декорация)
    police.x += (player.x + (player.w - police.w) / 2 - police.x) * 0.12;
    police.y = player.y + player.h + 12;
    
    // Движение разметки
    roadOffset = (roadOffset + speed) % DASH_PERIOD;
    
    // Деревья
    for (const t of trees) {
      t.y += speed;
      if (t.y > H + 20) t.y -= H + 100;
    }
    
    // Спавн врагов
    const spawnChance = 0.015 + Math.min(speed / 200, 0.025);
    if (Math.random() < spawnChance) spawnEnemy();

    // Движение врагов: скролл дороги минус собственная скорость (едут вперёд)
    for (const e of enemies) {
      e.y += speed - e.own;
    }

    // Разводим машины в одной полосе, чтобы они не проваливались друг в друга
    const GAP = 30;
    for (let lane = 0; lane < LANES; lane++) {
      // Сортируем по y: впереди (выше) — меньший y
      const inLane = enemies
        .filter(e => e.lane === lane)
        .sort((a, b) => a.y - b.y);
      for (let i = 1; i < inLane.length; i++) {
        const front = inLane[i - 1];
        const back = inLane[i];
        const minY = front.y + front.h + GAP;
        if (back.y < minY) {
          // Задняя не должна наезжать на переднюю
          back.y = minY;
          // Подстраиваем скорость под переднюю, чтобы не «толкать» её
          back.own = Math.min(back.own, front.own);
        }
      }
    }

    enemies = enemies.filter(e => e.y < H + 100);

    // Спавн и движение бонуса
    if (!bonus && ramFrames === 0 && Math.random() < 0.004) spawnBonus();
    if (bonus) {
      bonus.y += speed;
      if (bonus.y > H + 60) bonus = null;
      // Подбор бонуса
      if (bonus && collide(player, bonus)) {
        ramFrames = RAM_DURATION;
        bonus = null;
        score += 10;
      }
    }

    // Таймер режима тарана
    if (ramFrames > 0) ramFrames--;

    // Столкновения
    for (const e of enemies) {
      if (collide(player, e)) {
        if (ramFrames > 0) {
          // Таран: враг разбивается, начисляются доп. очки
          e.destroyed = true;
          score += 5;
          shake = 8;
        } else {
          gameOver = true;
          shake = 20;
          if (score > best) {
            best = score;
            localStorage.setItem('racer_best', best);
          }
        }
      }
    }
    enemies = enemies.filter(e => !e.destroyed);
    
    // Очки и ускорение
    if (frame % 3 === 0) score++;
    if (frame % 300 === 0 && speed < 14) speed += 0.5;
    
    if (shake > 0) shake--;
  }

  function draw() {
    ctx.save();
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }
    
    drawRoad();
    drawTrees();

    // Бонус
    if (bonus) drawBonus(bonus);

    // Враги
    for (const e of enemies) {
      drawCar(e.x, e.y, e.w, e.h, e.color, false);
    }

    // Аура тарана вокруг игрока
    if (ramFrames > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.9)';
      ctx.lineWidth = 3;
      ctx.shadowColor = '#ffd700';
      ctx.shadowBlur = 18;
      ctx.strokeRect(player.x - 4, player.y - 4, player.w + 8, player.h + 8);
      ctx.restore();
    }

    // Игрок
    drawCar(player.x, player.y, player.w, player.h, player.color, true);

    // Полицейская машина (декорация, едет за игроком)
    drawPolice(police.x, police.y, police.w, police.h);

    drawHUD();
    
    ctx.restore();
    
    if (!started && !gameOver) {
      drawOverlay('🚗 ГОНЩИК', 'Нажми любую клавишу', '#4cc9f0');
    } else if (paused) {
      drawOverlay('⏸ ПАУЗА', 'Пробел — продолжить', '#fbbf24');
    } else if (gameOver) {
      drawOverlay('💥 АВАРИЯ!', 'Enter — заново', '#ff3b3b');
    }
  }

  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  console.log('Запуск игры...');
  loop();
});