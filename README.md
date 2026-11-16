<div align="center">

# 🎨 Wplace Auto Color

**Расширение для Chrome/Edge: автоматический выбор цвета шаблона при ручном рисовании на wplace.live**<br>
**Chrome/Edge extension: auto-picks the template color while you draw by hand on wplace.live**

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![Version](https://img.shields.io/badge/version-1.12.0-7dd3fc)
![No network calls](https://img.shields.io/badge/extra%20network%20requests-0-brightgreen)

[🇷🇺 Русский](#-русский) · [🇬🇧 English](#-english)

</div>

---

## 🇷🇺 Русский

Рисуешь по шаблону на [wplace.live](https://wplace.live) и устал переключать цвета? Держи **Q** и веди мышью —
расширение для каждого пикселя под курсором само выбирает цвет из шаблона и добавляет пиксель в выделение.
Окончательную покраску ты запускаешь сам обычной кнопкой сайта.

### ✨ Возможности

- 🖌️ **Рисование с зажатой Q** — цвет шаблона выбирается перед каждым пикселем автоматически.
- ▭ **Выделение прямоугольником** — два клика по углам, пиксели обходятся змейкой.
- 🧠 **Без лишней работы** — пиксели, которые уже нужного цвета или недавно покрашены, пропускаются.
- ⚡ **Всегда свежая позиция** — расширение не «догоняет» старый путь курсора; размер буфера настраивается.
- 🔒 **Аккуратно с сайтом** — не вызывает API рисования, не шлёт своих `fetch`/XHR и не меняет запросы:
  только штатные обработчики страницы.

### 📦 Установка

1. Скачай репозиторий (**Code → Download ZIP**) и распакуй, или `git clone https://github.com/yawlick/wplace-addon.git`.
2. Открой `chrome://extensions` (или `edge://extensions`).
3. Включи **«Режим разработчика»**.
4. Нажми **«Загрузить распакованное расширение»** и выбери папку `extension/`.
5. Обнови вкладку wplace.live.

### 🎮 Управление

| Клавиша | Действие |
|---|---|
| **F8** | включить / выключить |
| **Q** (держать) | рисовать под курсором цветом шаблона |
| Панель справа | задержки, буфер, выделение прямоугольником |

Подробно о том, как это устроено, — в [`extension/README.md`](extension/README.md).

### 🛠️ Для разработчиков

`npm run download:site` сохраняет JS-бандлы сайта в `snapshot/` (с SHA-256 в `snapshot/manifest.json`),
чтобы сравнивать версии сайта. Снимок в репозиторий не входит.

> Неофициальный проект, не связан с wplace.live. Используй на свой страх и риск и соблюдай правила сайта.

---

## 🇬🇧 English

Drawing a template on [wplace.live](https://wplace.live) and tired of switching colors? Hold **Q** and move the mouse:
for every pixel under the cursor, the extension picks the template color and adds the pixel to your selection.
You still paint it yourself with the site's own button.

> The extension's UI is in Russian for now.

### ✨ Features

- 🖌️ **Hold-Q drawing**: the template color is selected automatically before each pixel.
- ▭ **Rectangle selection**: two clicks on opposite corners; pixels are walked in a snake pattern.
- 🧠 **No wasted pixels**: pixels that already have the right color, or were painted recently, are skipped.
- ⚡ **Always the latest position**: it never "catches up" on an old cursor path; the buffer size is configurable.
- 🔒 **Gentle on the site**: no calls to the drawing API, no extra `fetch`/XHR, no modified requests.
  It only uses the page's own handlers.

### 📦 Install

1. Download the repo (**Code → Download ZIP**) and unzip it, or `git clone https://github.com/yawlick/wplace-addon.git`.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the `extension/` folder.
5. Reload your wplace.live tab.

### 🎮 Controls

| Key | Action |
|---|---|
| **F8** | toggle on / off |
| **Q** (hold) | paint under the cursor with the template color |
| Side panel | delays, buffer size, rectangle selection |

How it works under the hood (in Russian): [`extension/README.md`](extension/README.md).

### 🛠️ For developers

`npm run download:site` saves the site's JS bundles into `snapshot/` (with SHA-256 hashes in `snapshot/manifest.json`)
so you can diff site versions. The snapshot isn't part of the repo.

> Unofficial project, not affiliated with wplace.live. Use at your own risk and follow the site's rules.
