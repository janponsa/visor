// Crear un worker inline com a Blob per la generació del GIF
var gifWorkerBlob = new Blob([
  `importScripts('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js')`
], { type: 'application/javascript' });

var gifWorkerUrl = URL.createObjectURL(gifWorkerBlob);

window.addEventListener('load', () => {
  const loadingScreen = document.getElementById('loading-screen');
  
  // Després de 4 segons, comencem la transició per amagar la pantalla
  setTimeout(() => {
    loadingScreen.classList.add('hidden');
    
    // I un segon després (el que dura l'animació), l'eliminem del tot
    // canviant el seu estil a 'display: none'. Aquest és el pas clau.
    setTimeout(() => {
        loadingScreen.style.display = 'none';
    }, 1000); // Aquest temps (1000ms) ha de coincidir amb la durada de la transició al teu CSS.

  }, 4000); // Temps total que la pantalla és visible abans de començar a desaparèixer.
});


// Plugin per dibuixar la icona del llamp sobre les barres del gràfic
const lightningJumpPlugin = {
    id: 'lightningJumpIcon',
    afterDraw: (chart, args, options) => {
        const { jumps } = options;
        if (!jumps || jumps.length === 0) return;

        const { ctx } = chart;
        ctx.save();
        ctx.font = '20px Arial';
        ctx.fillStyle = 'black';
        ctx.textAlign = 'center';

        jumps.forEach(jump => {
            const meta = chart.getDatasetMeta(0);
            const bar = meta.data[jump.index];
            if (bar) {
                const x = bar.x;
                const y = bar.y - 5; // 5 píxels per sobre de la barra
                ctx.fillText('⚡', x, y);
            }
        });
        ctx.restore();
    }
};

let isAutoDetectMode = true; // Comencem en mode automàtic per defecte

function toggleAnalysisMode() {
    if (isAutoDetectMode) {
        // Mode Automàtic
        map.removeControl(drawControl);
        drawnItems.clearLayers();
        const overlay = document.getElementById('lightning-jump-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
        if (lightningChart) {
            lightningChart.destroy();
            lightningChart = null;
        }
        if (realtimeLightningManager.historicStrikes.size > 0) {
            analitzarTempestesSMC();
        }
    } else {
        // Mode Manual
        map.addControl(drawControl);
        cellulesTempestaLayer.clearLayers();
        ljIconsLayer.clearLayers(); // <-- AFEGIM LA NETEJA AQUÍ TAMBÉ
    }
}

// Registrem el plugin perquè Chart.js el pugui utilitzar
Chart.register(lightningJumpPlugin);

// La resta del teu codi (var gifWorkerBlob, etc.) continua aquí...

// Configuració inicial
const max_range_steps = 30;
const increment_mins = 6;
const possibles_mins = Array.from({ length: 10 }, (_, i) => i * 6);
let range_values = [];
const range_element = document.getElementById('range-slider');
let historicModeTimestamp = null; // Si és null, estem en mode directe. Si té una data, estem en mode històric.

// Variables d'animació
let isPlaying = false;
let animationInterval = null;
const animationSpeed = 130;
const pauseOnLastFrame = 1200;

// Variables GIF
let gif = null;
let captureInProgress = false;
const totalGifFrames = 30;
const gifFrameDelay = 100;

// Funció per formatar números
const fillTo = (num, length) => String(num).padStart(length, '0');

// Capa personalitzada sense parpelleig
L.TileLayerNoFlickering = L.TileLayer.extend({
  _refreshTileUrl: function(tile, url) {
    const img = new Image();
    img.onload = () => L.Util.requestAnimFrame(() => tile.el.src = url);
    img.src = url;
  },
  refresh: function() {
    const wasAnimated = this._map._fadeAnimated;
    this._map._fadeAnimated = false;

    Object.keys(this._tiles).forEach(key => {
      const tile = this._tiles[key];
      if (tile.current && tile.active) {
        const oldsrc = tile.el.src;
        const newsrc = this.getTileUrl(tile.coords);
        if (oldsrc !== newsrc) this._refreshTileUrl(tile, newsrc);
      }
    });

    if (wasAnimated) setTimeout(() => this._map._fadeAnimated = wasAnimated, 5000);
  }
});

L.tileLayerNoFlickering = (url, options) => new L.TileLayerNoFlickering(url, options);

// ===================================================================
// VERSIÓ FINAL CORREGIDA: Classe personalitzada per a la capa base de Meteocat
// Aquesta versió implementa la conversió de coordenades TMS estàndard.
// ===================================================================
L.TileLayer.Meteocat = L.TileLayer.extend({
    getTileUrl: function (coords) {
        const z = coords.z;
        const x = coords.x;
        
        // Fórmula de conversió estàndard de coordenades de Leaflet a TMS.
        // Leaflet (origen a dalt) -> TMS (origen a baix)
        const y_tms = Math.pow(2, z) - coords.y - 1;

        // Funció auxiliar per emplenar amb zeros
        const fill = (num, len) => String(num).padStart(len, '0');

        // Calculem els components dinàmics de la URL amb les coordenades correctes
        const dirX = fill(Math.floor(x / 1000), 3);
        const fileX = fill(x % 1000, 3);
        
        const dirY = fill(Math.floor(y_tms / 1000), 3);
        const fileY = fill(y_tms % 1000, 3);

        const zoom = fill(z, 2);

        // Construïm la URL final
        return `https://static-m.meteo.cat/tiles/fons/GoogleMapsCompatible/${zoom}/000/${dirX}/${fileX}/000/${dirY}/${fileY}.png`;
    }
});

// Funció "factory" per conveniència
L.tileLayer.meteocat = function (options) {
    return new L.TileLayer.Meteocat('', options);
};

// Funció per generar dades temporals
function setRangeValues() {
  range_values = [];
  let curr_date = new Date();

  const curr_min = curr_date.getUTCMinutes();
  const min = Math.max(...possibles_mins.filter(m => m <= curr_min));
  curr_date.setUTCMinutes(min, 0, 0);

  for (let i = 0; i < max_range_steps; i++) {
    range_values.push({
      any: curr_date.getUTCFullYear(),
      mes: curr_date.getUTCMonth() + 1,
      dia: curr_date.getUTCDate(),
      hora: curr_date.getUTCHours(),
      min: curr_date.getUTCMinutes(),
      utctime: curr_date.getTime()
    });
    curr_date = new Date(curr_date.getTime() - (increment_mins * 60 * 1000));
  }
  range_values.reverse();
}

// Funció per actualitzar el text amb la data actual
function setDateText(r) {
  const t = new Date(r.utctime);
  document.getElementById("plujaoneu-text").textContent =
    `${fillTo(t.getUTCDate(), 2)}/${fillTo(t.getUTCMonth() + 1, 2)}/${t.getUTCFullYear()} ` +
    `${fillTo(t.getUTCHours(), 2)}:${fillTo(t.getUTCMinutes(), 2)} UTC`;
}

// Funció extra per actualitzar el progrés (si la necessites)
function updateProgress(percent) {
  document.getElementById('progress').textContent = `${Math.round(percent)}%`;
}

// Configuració de la capa pluja/neu
const plujaneu_layer = L.tileLayerNoFlickering('https://static-m.meteo.cat/tiles/plujaneu/{any}/{mes}/{dia}/{hora}/{minut}/{z}/000/000/{x}/000/000/{y}.png', {
  attribution: '© <a href="https://www.meteo.cat/" target="_blank">Meteocat</a>',
  opacity: 0.85,
  maxNativeZoom: 7
});

plujaneu_layer.on('add', function() {
  plujaneu_layer.getContainer().classList.add('pixelated-tile');
});

plujaneu_layer.getTileUrl = function(coords) {
  if (!range_values.length || range_element.value >= range_values.length) return '';

  const r = range_values[range_element.value];
  return L.Util.template(this._url, {
    any: r.any,
    mes: fillTo(r.mes, 2),
    dia: fillTo(r.dia, 2),
    hora: fillTo(r.hora, 2),
    minut: fillTo(r.min, 2),
    z: fillTo(coords.z, 2),
    x: fillTo(coords.x, 3),
    y: fillTo(Math.abs(coords.y - 127), 3)
  });
};

// Inicialització del mapa
setRangeValues();

// Creació del mapa amb Leaflet
const map = L.map('map', {
  layers: [] // Comencem sense capes per afegir-les després amb el control
}).setView([41.8, 1.6], 8); // Centrem una mica millor per a Catalunya

map.createPane('llampsPane');
map.getPane('llampsPane').style.zIndex = 450; // Nivell inferior

map.createPane('poligonsPane');
map.getPane('poligonsPane').style.zIndex = 500; // Nivell intermedi

map.createPane('iconesPane');
map.getPane('iconesPane').style.zIndex = 550; // Nivell superior


// ===================================================================
// SOLUCIÓ: Mou i enganxa les dues línies aquí
// ===================================================================
var drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);
// ===================================================================

var drawControl = new L.Control.Draw({
    draw: {
        polygon: true, // Permet només dibuixar polígons
        polyline: false,
        rectangle: false,
        circle: false,
        marker: false,
        circlemarker: false
    },
    edit: {
        featureGroup: drawnItems,
        edit: false, // Desactivem l'edició per simplicitat
        remove: true
    }
});
map.addControl(drawControl);


// Quan els polígons s'ESBORREN
map.on(L.Draw.Event.CREATED, function (event) {
    if (!isAutoDetectMode) { // Només s'executa si el mode automàtic està desactivat
        var layer = event.layer;
        drawnItems.clearLayers();
        drawnItems.addLayer(layer);
        analisisPolygon = layer.toGeoJSON();
        analitzarLightningJump(); // Crida a l'anàlisi manual
    }
});
// ===================================================================

map.on(L.Draw.Event.DELETED, function () {
    if (!isAutoDetectMode) { // Només s'executa en mode manual
        analisisPolygon = null;
        drawnItems.clearLayers();
        
        // Tanquem i destruïm el gràfic si estava obert
        const overlay = document.getElementById('lightning-jump-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
        if (lightningChart) {
            lightningChart.destroy();
            lightningChart = null;
        }
    }
});

// create a fullscreen button and add it to the map
L.control.fullscreen({
  position: 'topleft',
  title: 'Pantalla completa',
  titleCancel: 'Sortir de la pantalla completa',
  content: null,
  forceSeparateButton: false,
  forcePseudoFullscreen: false,
  fullscreenElement: false
}).addTo(map);


// events are fired when entering or exiting fullscreen.
map.on('enterFullscreen', function () {
	console.log('entered fullscreen');
});

map.on('exitFullscreen', function () {
	console.log('exited fullscreen');
});

// Capa de radar (nova)
const radar_layer = L.tileLayerNoFlickering('https://static-m.meteo.cat/tiles/radar/{any}/{mes}/{dia}/{hora}/{minut}/{z}/000/000/{x}/000/000/{y}.png', {
  attribution: '© <a href="https://www.meteo.cat/" target="_blank">Meteocat</a>',
  opacity: 0.85,
  maxNativeZoom: 7
});

radar_layer.on('add', function() {
  radar_layer.getContainer().classList.add('pixelated-tile');
});

radar_layer.getTileUrl = function(coords) {
  if (!range_values.length || range_element.value >= range_values.length) return '';

  const r = range_values[range_element.value];
  return L.Util.template(this._url, {
    any: r.any,
    mes: fillTo(r.mes, 2),
    dia: fillTo(r.dia, 2),
    hora: fillTo(r.hora, 2),
    minut: fillTo(r.min, 2),
    z: fillTo(coords.z, 2),
    x: fillTo(coords.x, 3),
    y: fillTo(Math.abs(coords.y - 127), 3)
  });
};

// Llista de capes dependents del temps
const timeDependentLayers = [plujaneu_layer, radar_layer];

// Modificar l'esdeveniment del slider
range_element.addEventListener('input', () => {
  timeDependentLayers.forEach(layer => {
    if (map.hasLayer(layer)) layer.refresh();
  });
  setDateText(range_values[range_element.value]);
});

// Modificar la funció d'animació
function nextFrame() {
  if (!isPlaying) return;

  let currentStep = parseInt(range_element.value);
  if (currentStep >= range_values.length - 1) currentStep = 0;
  else currentStep++;

  range_element.value = currentStep;
  timeDependentLayers.forEach(layer => {
    if (map.hasLayer(layer)) layer.refresh();
  });
  setDateText(range_values[currentStep]);

  const delay = (currentStep === range_values.length - 1) ? pauseOnLastFrame : animationSpeed;
  animationInterval = setTimeout(nextFrame, delay);
}

const baseLayers = {
  "OpenStreetMap": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }),
  "Topografia": L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a>'
  }),
  "Satèl·lit": L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© <a href="https://www.arcgis.com/">ESRI</a>'
  }),
  "Fosc": L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://carto.com/">CARTO</a>'
  }),
  "Blanc": L.tileLayer('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQMAAABmvDolAAAAA1BMVEX///+nxBvIAAAAH0lEQVRoge3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAABmmDh1QAAAABJRU5ErkJggg==', {
      attribution: '',
      tileSize: 256,
      minZoom: 0,
      maxZoom: 20
  }),
  "Meteocat": L.tileLayer.meteocat({ // <<< Canvi important aquí
    attribution: '© <a href="https://meteo.cat">Meteocat</a>',
    minZoom: 7,
    maxZoom: 13
  }),
  "Topografic ICGC": L.tileLayer.wms("https://geoserveis.icgc.cat/servei/catalunya/mapa-base/wms/service?", {
    layers: 'topografic',
    format: 'image/jpeg',
    continuousWorld: true,
    attribution: 'Institut Cartogràfic i Geològic de Catalunya',
  }),
  "Lidar": L.tileLayer.wms("https://wms-mapa-lidar.idee.es/lidar?", {
    layers: 'EL.GridCoverage',
    format: 'image/jpeg',
    crs: L.CRS.EPSG3857,
    continuousWorld: true,
    attribution: 'Instituto Geografico Nacional',
  }),
    // --- Capes JSON de l'ICGC (Mapes Generals) ---
    "ICGC (JSON) Estàndard General": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_estandard_general.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Estàndard Simplificat": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_estandard.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Gris": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_base_gris.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC Relleu": L.mapboxGL({
        style: 'full_relleu.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Fosc": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_base_fosc.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),

    // --- Capes JSON de l'ICGC (Mapes d'Imatge) ---
    "ICGC (JSON) Orto Híbrida": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_orto_hibrida.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Orto Estàndard": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_orto_estandard.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Orto amb Xarxa Viària": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_orto_xarxa_viaria.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
     "ICGC (JSON) Orto Estàndard Gris": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_orto_estandard_gris.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),

    // --- Capes JSON de l'ICGC (Mapes Administratius) ---
    "ICGC (JSON) Delimitació Estàndard": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_delimitacio_estandard.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Delimitació Gris": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_delimitacio_gris.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Límits Administratius": L.mapboxGL({
        style: 'relleu_comarques.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
};

// Controla el zoom només per a la capa Meteocat
function updateZoomRestrictions() {
  if (map.hasLayer(baseLayers.Meteocat)) {
    // Apliquem els nous límits de zoom per a la capa de Meteocat
    map.options.minZoom = 7;
    map.options.maxZoom = 13; // Canviat de 12 a 13
    // Ajustem el zoom actual si queda fora dels nous límits
    map.setZoom(Math.max(7, Math.min(13, map.getZoom())));
  } else {
    // Per a la resta de capes, restaurem el zoom per defecte
    map.options.minZoom = 1;
    map.options.maxZoom = 18;
  }
}

map.on('baselayerchange', updateZoomRestrictions);
baseLayers.Meteocat.addTo(map); // Afegeix una capa base per defecte

// Capa WMS ICGC Allaus
const wmsLayer = L.tileLayer.wms("https://geoserveis.icgc.cat/geoserver/nivoallaus/wms", {
  layers: 'nivoallaus:zonesnivoclima',
  format: 'image/png',
  transparent: true,
  attribution: '© <a href="https://www.icgc.cat/">ICGC</a>',
  opacity: 0.7,
  version: '1.3.0',
  tileSize: 512,
  minZoom: 1,
  maxZoom: 18,
  continuousWorld: true,
  noWrap: true
});

// Capa de comarques
var comarquesLayer = L.geoJSON(comarquesGeojson, {
  style: { color: "#262626", weight: 1, fill: false }
});

// Capa de municipis
var municipisGeojsonLayer = L.geoJSON(municipisGeojson, { // Canviat el nom de la variable per evitar conflictes
  style: { color: "#4F4F4F", weight: 1.2, fill: false }
});

// Capa per a les càmeres
const camerasLayer = L.layerGroup();
if (typeof webcamPoints !== 'undefined' && Array.isArray(webcamPoints)) {
    const cameraIcon = L.divIcon({
        html: '<span style="font-size:24px;">📍</span>',
        className: 'webcam-icon',
        iconSize: [30, 30],
        iconAnchor: [15, 15] // Centra l'emoji sobre la coordenada
    });
    webcamPoints.forEach(cam => {
        const popupContent = `
            <div style="text-align:center;">
              <h4 style="margin:0 0 5px;">${cam.location}</h4>
              <a href="${cam.link}" target="_blank">
                <img src="${cam.image}?_=${Date.now()}" alt="${cam.location}" style="width:300px; height:169px; object-fit: cover; border:1px solid #ccc;"/>
              </a>
              <p style="margin:5px 0 0;">
                <a href="${cam.link}" target="_blank">Veure càmera en directe</a>
              </p>
            </div>`;
        L.marker([cam.lat, cam.lon], { icon: cameraIcon })
            .bindPopup(popupContent)
            .addTo(camerasLayer);
    });
}


// Capa WMS Xarxa Hidrogràfica
const xarxaHidrograficaLayer = L.tileLayer.wms("https://aplicacions.aca.gencat.cat/geoserver/gwc/service/wms?", {
  layers: 'Xarxa_hidrografica',
  format: 'image/png',
  transparent: true,
  version: '1.3.0',
  crs: L.CRS.EPSG3857,
  attribution: '© <a href="https://www.aca.gencat.cat/">ACA</a>',
  opacity: 0.7
});


/**
 * Troba el timestamp de l'última dada de l'SMC que hauria d'estar disponible,
 * tenint en compte els retards de publicació (dades disponibles als minuts :16 i :46 aprox).
 * @param {Date} date - La data a partir de la qual calcular.
 * @returns {Date} Un objecte Date amb el timestamp de l'última dada disponible.
 */

/**
 * Calcula un timestamp objectiu basat en l'hora actual.
 * Aquesta funció està sincronitzada amb la lògica de 'fetchSmcData'.
 * @param {Date} date - La data a partir de la qual calcular.
 * @returns {Date} Un objecte Date amb el timestamp calculat.
 */
function findLatestSmcTimestamp(date) {
    const targetDate = new Date(date.getTime()); // Treballem sobre una còpia
    const currentUtcMinutes = targetDate.getUTCMinutes();

    // ======================================================
    // INICI DE LA MODIFICACIÓ
    // Aquesta lògica ara és idèntica a la de 'fetchSmcData'
    // ======================================================
    if (currentUtcMinutes >= 46) {
        targetDate.setUTCMinutes(0, 0, 0);
    } else if (currentUtcMinutes >= 16) {
        targetDate.setUTCHours(targetDate.getUTCHours() - 1);
        targetDate.setUTCMinutes(30, 0, 0);
    } else {
        targetDate.setUTCHours(targetDate.getUTCHours() - 1);
        targetDate.setUTCMinutes(0, 0, 0);
    }
    // ======================================================
    // FI DE LA MODIFICACIÓ
    // ======================================================
    
    return targetDate;
}

// ===================================================================
// NOU SISTEMA UNIFICAT DE VISUALITZACIÓ DE DADES (VERSIÓ FINAL CORREGIDA)
// ===================================================================

let isLoadingData = false;
const aemetApiKey = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5wb25zYUBnbWFpbC5jb20iLCJqdGkiOiI1OTZhMjQ3MC0zODg2LTRkNzktOTE3OC01NTA5MDI5Y2MwNjAiLCJpc3MiOiJBRU1FVCIsImlhdCI6MTUyMTA0OTg0MywidXNlcklkIjoiNTk2YTI0NzAtMzg4Ni00ZDc5LTkxNzgtNTUwOTAyOWNjMDYwIiwicm9sZSI6IiJ9.rmsBWXYts5VUBXKlErX7i9W0e3Uz-sws33bgRcIvlug";

const VARIABLES_CONFIG = {
    // --- Temperatura ---
    'smc_32': { id: 32, name: 'Temperatura', unit: '°C', decimals: 1, aemet_id: 'ta' },
    'smc_40': { id: 40, name: 'Temperatura màxima', unit: '°C', decimals: 1, aemet_id: 'tamax', summary: 'max' },
    'smc_42': { id: 42, name: 'Temperatura mínima', unit: '°C', decimals: 1, aemet_id: 'tamin', summary: 'min' },
    'dewpoint': {
    name: 'Punt de Rosada',
    unit: '°C',
    decimals: 1,
    isHybrid: true, // Nova propietat per identificar aquesta variable especial
    smc_sources: { temp: 32, rh: 33 }, // Variables SMC necessàries per al càlcul
    aemet_id: 'tpr' // Clau per al valor directe d'AEMET
    },
    // --- Humitat ---
    'smc_33': { id: 33, name: 'Humitat relativa', unit: '%', decimals: 0, aemet_id: 'hr' },
    'smc_3':  { id: 3,  name: 'Humitat relativa màxima', unit: '%', decimals: 0, aemet_id: null, summary: 'max' },
    'smc_44': { id: 44, name: 'Humitat relativa mínima', unit: '%', decimals: 0, aemet_id: null, summary: 'min' },
    // --- Vent ---
    'wind': { name: 'Dades de Vent Base', internal: true }, // Variable interna per a càlculs
    'wind_speed_ms': { name: 'Velocitat Vent', unit: 'm/s', base_id: 30, isSimpleWind: true, conversion: 1, decimals: 1 },
    'wind_speed_kmh': { name: 'Velocitat Vent', unit: 'km/h', base_id: 30, isSimpleWind: true, conversion: 3.6, decimals: 1 },
    'wind_gust_semihourly_ms': { name: 'Ratxa Màx. (Semi-h)', unit: 'm/s', base_id: 50, isSimpleWind: true, conversion: 1, decimals: 1 },
    'wind_gust_semihourly_kmh': { name: 'Ratxa Màx. (Semi-h)', unit: 'km/h', base_id: 50, isSimpleWind: true, conversion: 3.6, decimals: 1 },
    'wind_gust_daily_ms': { name: 'Ratxa Màx. Diària', unit: 'm/s', id: 50, summary: 'max', conversion: 1, decimals: 1 },
    'wind_gust_daily_kmh': { name: 'Ratxa Màx. Diària', unit: 'km/h', id: 50, summary: 'max', conversion: 3.6, decimals: 1 },
    'wind_barbs': { name: 'Direcció i Velocitat', isWindBarb: true },

    // --- Precipitació ---
    'precip_semihoraria': { id: 35, name: 'Precipitació Semihorària', unit: 'mm', decimals: 1, isSemihoraria: true }, // <-- LÍNIA NOVA
    'smc_35': { id: 35, name: 'Precipitació acumulada', unit: 'mm', decimals: 1, aemet_id: 'prec', summary: 'sum' },
    'smc_72': { id: 72, name: 'Precipitació màxima en 1 minut', unit: 'mm', decimals: 1, aemet_id: null },
    'smc_72_daily_max': { id: 72, name: 'Intensitat Màx. Diària', unit: 'mm/min', decimals: 1, summary: 'max' },
    // Afegeix aquestes dues "variables virtuals" dins del teu objecte VARIABLES_CONFIG
'alert_intensity': {
    id: 35, // Basat en la precipitació (id: 35)
    name: 'Alerta per Intensitat (>20mm/30min)',
    unit: 'mm',
    decimals: 1,
    summary: 'max', // <-- LA CLAU: demanem el MÀXIM valor del dia
    isAlert: true,
    alertThreshold: 20
},
'alert_accumulation': {
    id: 35, // Basat en la precipitació (id: 35)
    name: 'Alerta per Acumulació (>50mm/dia)',
    unit: 'mm',
    decimals: 1,
    summary: 'sum', // <-- Aquí demanem el SUMATORI total del dia
    isAlert: true,
    alertThreshold: 50
},
    // --- Pressió ---
    'smc_34': { id: 34, name: 'Pressió atmosfèrica', unit: 'hPa', decimals: 1, aemet_id: 'pres' },
    'smc_1': { id: 1, name: 'Pressió atmosfèrica màxima', unit: 'hPa', decimals: 1, aemet_id: null, summary: 'max' },
    'smc_2': { id: 2, name: 'Pressió atmosfèrica mínima', unit: 'hPa', decimals: 1, aemet_id: null, summary: 'min' },
    // --- Neu ---
    'smc_38': { id: 38, name: 'Gruix de neu a terra', unit: 'cm', decimals: 0, aemet_id: null },
    // --- NOVES VARIABLES DE COMPARACIÓ ---
    'var_tmax_24h': { name: 'Variació Tª Màx. 24h', unit: '°C', decimals: 1, comparison: 'daily_summary', base_id: 40, summary: 'max' },
    'var_tmin_24h': { name: 'Variació Tª Mín. 24h', unit: '°C', decimals: 1, comparison: 'daily_summary', base_id: 42, summary: 'min' },
    'var_tactual_24h': { name: 'Variació Tª Actual 24h', unit: '°C', decimals: 1, comparison: 'instant', base_id: 32 },
    // --- VARIABLES CALCULADES ---
    'calc_amplitude': {
    name: 'Amplitud Tèrmica', unit: '°C', decimals: 1,
    isCalculated: true,
    sources: ['smc_40', 'smc_42'], // T. Màxima i T. Mínima
    calculation: (d) => d.smc_40 - d.smc_42,
    colorScale: [
        { value: 0, color: 'rgba(0, 150, 255, 1)' },   // Blau
        { value: 5, color: 'rgba(0, 220, 220, 1)' },   // Cian
        { value: 10, color: 'rgba(100, 255, 100, 1)' }, // Verd
        { value: 15, color: 'rgba(255, 255, 0, 1)' },  // Groc
        { value: 20, color: 'rgba(255, 150, 0, 1)' },  // Taronja
        { value: 25, color: 'rgba(255, 50, 50, 1)' },   // Vermell
        { value: 30, color: 'rgba(200, 0, 150, 1)' }    // Magenta
    ]
},
'calc_windchill': {
    name: 'Sensació Tèrmica (Vent)', unit: '°C', decimals: 1,
    isCalculated: true,
    sources: ['smc_32', 'wind'], // T. Actual i Vent
    calculation: (d) => {
        const temp = d.smc_32;
        const windKmh = Math.sqrt(d.wind.u**2 + d.wind.v**2) * 3.6; // Convertim de m/s a km/h
        if (temp > 10 || windKmh < 5) return temp; // La fórmula no s'aplica en aquestes condicions
        return 13.12 + 0.6215 * temp - 11.37 * Math.pow(windKmh, 0.16) + 0.3965 * temp * Math.pow(windKmh, 0.16);
    },
    colorScale: [ // Similar a la temperatura, però més freda
        { value: -20, color: 'rgba(180, 50, 255, 1)' },
        { value: -10, color: 'rgba(50, 50, 255, 1)' },
        { value: 0, color: 'rgba(0, 150, 255, 1)' },
        { value: 5, color: 'rgba(0, 220, 200, 1)' },
        { value: 10, color: 'rgba(150, 255, 150, 1)' }
    ]
},
'calc_humidex': {
    name: 'Temp. de Xafogor', unit: '°C', decimals: 1,
    isCalculated: true,
    sources: ['smc_32', 'smc_33'], // T. Actual i Humitat Relativa
    calculation: (d) => {
        const temp = d.smc_32;
        const hr = d.smc_33;
        if (temp < 20) return temp; // La xafogor no és significativa per sota de 20°C
        const dewPoint = temp - ((100 - hr) / 5);
        const e = 6.11 * Math.exp(5417.7530 * ((1 / 273.16) - (1 / (dewPoint + 273.15))));
        const h = 0.5555 * (e - 10.0);
        return temp + h;
    },
    colorScale: [ // Escala per a calor
        { value: 20, color: 'rgba(255, 255, 0, 1)' }, // Groc
        { value: 25, color: 'rgba(255, 200, 0, 1)' },
        { value: 30, color: 'rgba(255, 150, 0, 1)' }, // Taronja
        { value: 35, color: 'rgba(255, 80, 80, 1)' }, // Vermell
        { value: 40, color: 'rgba(200, 0, 150, 1)' }, // Magenta
        { value: 45, color: 'rgba(150, 0, 200, 1)' }  // Violeta
    ]
},
'calc_wetbulb': {
    name: 'Temperatura de Bulb Humit', unit: '°C', decimals: 1,
    isCalculated: true,
    sources: ['smc_32', 'smc_33'], // T. Actual i Humitat Relativa
    calculation: (d) => {
        const temp = d.smc_32;
        const rh = d.smc_33;

        // Comprovació per evitar errors matemàtics amb humitats invàlides
        if (rh <= 0 || rh > 105) {
            return null; // No mostrem valors per a dades invàlides
        }

        // Pas 1: Càlcul del Punt de Rosada (Td) - la mateixa fórmula que el teu codi antic
        const log_rh = Math.log(rh / 100);
        const temp_frac = (17.625 * temp) / (243.04 + temp);
        const td = (243.04 * (log_rh + temp_frac)) / (17.625 - log_rh - temp_frac);

        // Pas 2: Aproximació del Bulb Humit (Tw) amb la regla d'un terç
        const tw = temp - (temp - td) / 3;

        return tw;
    },
    colorScale: [ // L'escala de colors es manté
        { value: 10, color: 'rgba(0, 150, 255, 1)' },
        { value: 15, color: 'rgba(100, 255, 100, 1)' },
        { value: 20, color: 'rgba(255, 255, 0, 1)' },
        { value: 25, color: 'rgba(255, 150, 0, 1)' },
        { value: 30, color: 'rgba(255, 50, 50, 1)' },
        { value: 35, color: 'rgba(200, 0, 150, 1)' }
    ]
},
};

// Funció per obtenir la dada instantània de l'SMC per una data concreta
async function fetchSmcInstant(variableId, date) {
    // La data ja ve calculada correctament. Només la formatem.
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mi = String(date.getUTCMinutes()).padStart(2, '0');
    const timestampString = `${yyyy}-${mm}-${dd}T${hh}:${mi}:00.000`;

    const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?data_lectura=${timestampString}&codi_variable=${variableId}`;
    try {
        const data = await $.getJSON(urlDades);
        console.log(`Petició a ${urlDades} retornada amb ${data.length} registres.`);
        return data || [];
    } catch (error) {
        console.error(`Error obtenint dada instantània de l'SMC per a ${timestampString}:`, error);
        return [];
    }
}

// ===== REEMPLAÇA AQUESTA FUNCIÓ =====
function fetchSmcDailySummary(variableId, aggregationType, startDate, endDate) {
    return new Promise((resolve) => {
        // Converteix les dates a format ISO (UTC) i treu la 'Z' final, ja que l'API és flexible.
        const iniciDiaString = startDate.toISOString().slice(0, -1);
        const fiDiaString = endDate.toISOString().slice(0, -1);

        const selectClause = `codi_estacio, ${aggregationType}(valor_lectura) AS valor`;
        const whereClause = `data_lectura >= '${iniciDiaString}' AND data_lectura <= '${fiDiaString}' AND codi_variable = '${variableId}'`;
        const query = `$query=SELECT ${selectClause} WHERE ${whereClause} GROUP BY codi_estacio`;
        const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?${query}`;
        console.log("URL de la consulta:", urlDades);
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";

        $.when($.getJSON(urlDades), $.getJSON(urlMetadades)).done((dadesResponse, metadadesResponse) => {
            const [dadesVariable, metadata] = [dadesResponse[0], metadadesResponse[0]];
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));
            const processedData = dadesVariable.map(lectura => {
                const estacioInfo = estacionsMap.get(lectura.codi_estacio);
                return estacioInfo ? { source: 'smc', ...estacioInfo, ...lectura, timestamp: new Date().toISOString() } : null;
            }).filter(d => d !== null);
            resolve({ data: processedData, timestamp: new Date().toISOString() });
        }).fail(() => resolve({ data: [], timestamp: null }));
    });
}

// =====================================================================================
// 1. AFEGEIX AQUESTA NOVA FUNCIÓ
// Aquesta funció s'encarrega de demanar el sumatori de pluja a l'API
// =====================================================================================

/**
 * NOVA FUNCIÓ (A PROVA D'ERRORS DE L'API)
 * Obté TOTES les lectures de precipitació individuals per a un interval de dates.
 * @param {Date} startDate - Data d'inici de l'interval.
 * @param {Date} endDate - Data de fi de l'interval.
 * @returns {Promise<Object>} Una promesa que resol amb totes les lectures sense processar.
 */
function fetchAllPrecipitationReadings(startDate, endDate) {
    return new Promise((resolve) => {
        const iniciString = startDate.toISOString();
        const fiString = endDate.toISOString();

        // Consulta simple: selecciona només el codi i el valor, sense agregacions.
        const selectClause = `codi_estacio, valor_lectura`;
        const whereClause = `data_lectura >= '${iniciString}' AND data_lectura <= '${fiString}' AND codi_variable = '35'`;
        // Afegim un límit alt per si de cas, tot i que per a pocs dies no hauria de ser problema.
        const query = `$query=SELECT ${selectClause} WHERE ${whereClause} LIMIT 50000`; 
        
        const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?${query}`;
        console.log("URL final (sense SUM):", urlDades);

        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";

        $.when($.getJSON(urlDades), $.getJSON(urlMetadades)).done((dadesResponse, metadadesResponse) => {
            const [readings, metadata] = [dadesResponse[0], metadadesResponse[0]];
            resolve({ readings, metadata });
        }).fail((err) => {
            console.error("Error en la crida per obtenir lectures individuals:", err);
            resolve({ readings: [], metadata: [] });
        });
    });
}

// Funció per obtenir i processar dades d'AEMET
async function fetchAemetData() {
    const url = 'https://opendata.aemet.es/opendata/api/observacion/convencional/todas';
    try {
        const res1 = await fetch(url, { headers: { 'api_key': aemetApiKey }});
        const info = await res1.json();
        if (info.estado !== 200) throw new Error(info.descripcion);
        const res2 = await fetch(info.datos);
        return await res2.json();
    } catch (error) {
        console.error("Error AEMET:", error);
        return [];
    }
}

/**
 * Retorna un color interpolat basat en un valor i una escala de colors definida.
 * @param {number} value - El valor a pintar.
 * @param {Array<Object>} scale - L'escala de colors, ex: [{value: 0, color: 'rgba(r,g,b,a)'}, ...]
 * @returns {string} El color RGBA calculat.
 */
function getDynamicColor(value, scale) {
    // Si el valor és menor que el primer de l'escala, retorna el primer color.
    if (value <= scale[0].value) {
        return scale[0].color;
    }
    // Si el valor és major que l'últim, retorna l'últim color.
    if (value >= scale[scale.length - 1].value) {
        return scale[scale.length - 1].color;
    }

    // Busca el segment correcte a l'escala
    let lower, upper;
    for (let i = 0; i < scale.length - 1; i++) {
        if (value >= scale[i].value && value < scale[i+1].value) {
            lower = scale[i];
            upper = scale[i+1];
            break;
        }
    }

    // Interpola el color entre el límit inferior i superior del segment
    const percent = (value - lower.value) / (upper.value - lower.value);
    const c1 = lower.color.match(/(\d+(\.\d+)?)/g).map(Number);
    const c2 = upper.color.match(/(\d+(\.\d+)?)/g).map(Number);

    const r = Math.round(c1[0] + (c2[0] - c1[0]) * percent);
    const g = Math.round(c1[1] + (c2[1] - c1[1]) * percent);
    const b = Math.round(c1[2] + (c2[2] - c1[2]) * percent);
    const a = c1.length > 3 ? (c1[3] + (c2[3] - c1[3]) * percent) : 1;

    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ======================================================
// AFEGEIX AQUESTES NOVES ESCALES DE COLORS
// ======================================================

/**
 * Retorna un color per a la humitat relativa (%).
 * De marró (sec) a blau fosc (saturat).
 */
function getHumidityColor(rh) {
    const alpha = 1;
    if (rh < 20) return `rgba(188, 143, 143, ${alpha})`; // RosyBrown (molt sec)
    if (rh < 40) return `rgba(240, 230, 140, ${alpha})`; // Khaki (sec)
    if (rh < 60) return `rgba(152, 251, 152, ${alpha})`; // PaleGreen (moderat)
    if (rh < 80) return `rgba(60, 179, 113, ${alpha})`;  // MediumSeaGreen (humit)
    if (rh < 90) return `rgba(0, 191, 255, ${alpha})`;    // DeepSkyBlue (molt humit)
    return `rgba(0, 0, 205, ${alpha})`;                  // MediumBlue (saturat)
}

/**
 * Retorna un color per a la pressió atmosfèrica (hPa).
 * De taronja (baixa pressió) a blau/violeta (alta pressió).
 */
function getPressureColor(hpa) {
    const alpha = 1;
    if (hpa < 990) return `rgba(255, 127, 80, ${alpha})`;   // Coral (molt baixa)
    if (hpa < 1000) return `rgba(255, 165, 0, ${alpha})`;  // Orange (baixa)
    if (hpa < 1010) return `rgba(218, 165, 32, ${alpha})`; // Goldenrod (normal-baixa)
    if (hpa < 1020) return `rgba(144, 238, 144, ${alpha})`; // LightGreen (normal)
    if (hpa < 1030) return `rgba(173, 216, 230, ${alpha})`; // LightBlue (alta)
    return `rgba(147, 112, 219, ${alpha})`;                // MediumPurple (molt alta)
}

/**
 * Retorna un color per al gruix de neu (cm).
 * De blanc a blau fosc.
 */
function getSnowDepthColor(cm) {
    const alpha = 1;
    if (cm <= 0) return '#ffffff';                      // Blanc (sense neu)
    if (cm < 5) return `rgba(240, 248, 255, ${alpha})`; // AliceBlue
    if (cm < 10) return `rgba(173, 216, 230, ${alpha})`;// LightBlue
    if (cm < 25) return `rgba(135, 206, 250, ${alpha})`;// LightSkyBlue
    if (cm < 50) return `rgba(0, 191, 255, ${alpha})`;   // DeepSkyBlue
    if (cm < 100) return `rgba(30, 144, 255, ${alpha})`; // DodgerBlue
    return `rgba(0, 0, 139, ${alpha})`;                 // DarkBlue (molta neu)
}

function getTempRgbaColor(temp) {
    const alpha = 1;
    if (temp < -22) return `rgba(58, 5, 61, ${alpha})`;
    if (temp < -20) return `rgba(89, 12, 90, ${alpha})`;
    if (temp < -18) return `rgba(153, 32, 163, ${alpha})`;
    if (temp < -16) return `rgba(116, 29, 124, ${alpha})`;
    if (temp < -14) return `rgba(86, 14, 64, ${alpha})`;
    if (temp < -12) return `rgba(48, 50, 98, ${alpha})`;
    if (temp < -10) return `rgba(19, 49, 145, ${alpha})`;
    if (temp < -8)  return `rgba(0, 0, 196, ${alpha})`;
    if (temp < -6)  return `rgba(0, 0, 243, ${alpha})`;
    if (temp < -4)  return `rgba(34, 84, 245, ${alpha})`;
    if (temp < -2)  return `rgba(74, 153, 246, ${alpha})`;
    if (temp < 0)   return `rgba(104, 200, 250, ${alpha})`;
    if (temp < 2)   return `rgba(146, 251, 254, ${alpha})`;
    if (temp < 4)   return `rgba(147, 251, 164, ${alpha})`;
    if (temp < 6)   return `rgba(145, 251, 127, ${alpha})`;
    if (temp < 8)   return `rgba(147, 250, 81, ${alpha})`;
    if (temp < 10)  return `rgba(202, 248, 80, ${alpha})`;
    if (temp < 12)  return `rgba(253, 255, 84, ${alpha})`;
    if (temp < 14)  return `rgba(254, 255, 153, ${alpha})`;
    if (temp < 16)  return `rgba(249, 234, 109, ${alpha})`;
    if (temp < 18)  return `rgba(245, 206, 69, ${alpha})`;
    if (temp < 20)  return `rgba(240, 158, 58, ${alpha})`;
    if (temp < 22)  return `rgba(237, 114, 46, ${alpha})`;
    if (temp < 24)  return `rgba(231, 89, 65, ${alpha})`;
    if (temp < 26)  return `rgba(232, 72, 36, ${alpha})`;
    if (temp < 28)  return `rgba(230, 52, 40, ${alpha})`;
    if (temp < 30)  return `rgba(211, 45, 33, ${alpha})`;
    if (temp < 32)  return `rgba(164, 32, 19, ${alpha})`;
    if (temp < 34)  return `rgba(140, 26, 16, ${alpha})`;
    if (temp < 36)  return `rgba(99, 16, 10, ${alpha})`;
    if (temp < 38)  return `rgba(115, 20, 78, ${alpha})`;
    if (temp < 40)  return `rgba(146, 28, 114, ${alpha})`;
    if (temp < 42)  return `rgba(188, 38, 197, ${alpha})`;
    if (temp < 44)  return `rgba(229, 52, 244, ${alpha})`;
    if (temp < 46)  return `rgba(234, 81, 247, ${alpha})`;
    return `rgba(241, 134, 250, ${alpha})`;
}

// ===== BLOC DE FUNCIONS DEFINITIU (COPIAR I ENGANXAR AL LLOC NET) =====

// VERSIÓ FINAL: Càrrega dades de SMC per a una data concreta (o la més recent)
function fetchSmcData(variableId, targetDate = null) {
    return new Promise((resolve) => {
        if (variableId === null) return resolve({ data: [] });
        let timestampToUse = targetDate ? new Date(targetDate.getTime()) : findLatestSmcTimestamp(new Date());
        const yyyy = timestampToUse.getUTCFullYear();
        const mm = String(timestampToUse.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(timestampToUse.getUTCDate()).padStart(2, '0');
        const hh = String(timestampToUse.getUTCHours()).padStart(2, '0');
        const mi = String(timestampToUse.getUTCMinutes()).padStart(2, '0');
        const finalTimestampString = `${yyyy}-${mm}-${dd}T${hh}:${mi}:00.000`;
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";
        $.getJSON(urlMetadades).done(metadata => {
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));
            const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?data_lectura=${finalTimestampString}&codi_variable=${variableId}`;
            $.getJSON(urlDades).done(dadesVariable => {
                const processedData = dadesVariable.map(lectura => {
                    const estacioInfo = estacionsMap.get(lectura.codi_estacio);
                    return estacioInfo ? { source: 'smc', ...estacioInfo, valor: lectura.valor_lectura, timestamp: finalTimestampString + 'Z', codi_estacio: lectura.codi_estacio } : null;
                }).filter(Boolean);
                resolve({ data: processedData });
            }).fail(() => resolve({ data: [] }));
        }).fail(() => resolve({ data: [] }));
    });
}

// VERSIÓ FINAL: Càrrega de dades de vent de 3 nivells
async function fetchAllWindData(dataType, targetDate = null) {
    let speed_ids, dir_ids;
    if (dataType === 'speed') { speed_ids = [30, 48, 46]; dir_ids = [31, 49, 47]; } 
    else { speed_ids = [50, 53, 56]; dir_ids = [51, 54, 57]; }
    const promises = [...speed_ids, ...dir_ids].map(id => fetchSmcData(id, targetDate));
    const results = await Promise.all(promises);
    const speedResults = results.slice(0, 3), dirResults = results.slice(3, 6);
    const finalWindData = new Map();
    for (let i = 0; i < 3; i++) {
        const dirMap = new Map(dirResults[i].data.map(d => [d.codi_estacio, parseFloat(d.valor)]));
        speedResults[i].data.forEach(station => {
            if (!finalWindData.has(station.codi_estacio) && dirMap.has(station.codi_estacio)) {
                finalWindData.set(station.codi_estacio, { ...station, speed_ms: parseFloat(station.valor), direction: dirMap.get(station.codi_estacio) });
            }
        });
    }
    return Array.from(finalWindData.values());
}

// --- FUNCIONS DE VISUALITZACIÓ DEFINITIVES ---

// ======================================================
// AFEGEIX AQUESTA FUNCIÓ AL TEU CODI
// ======================================================
function stopAllDataLayers() {
    // Atura i neteja el gestor de llamps si està actiu
    if (typeof realtimeLightningManager !== 'undefined' && realtimeLightningManager.isActive) {
        realtimeLightningManager.stop();
    }

    // Neteja les capes de dades existents (com les de temperatura, vent, etc.)
    if (typeof dataMarkersLayer !== 'undefined') {
        dataMarkersLayer.clearLayers();
    }

    // Atura la capa de vent (convergències) si està activa
    if (typeof convergencesLayer !== 'undefined' && map.hasLayer(convergencesLayer)) {
        convergencesLayer.remove(); // Això activarà l'esdeveniment 'remove' que neteja l'interval
    }
    
    // Amaga el panell del sumatori si estava visible
    const sumatoriControls = document.getElementById('sumatori-controls');
    if (sumatoriControls) {
        sumatoriControls.style.display = 'none';
    }

    console.log("Totes les capes de dades han estat aturades i netejades.");
}



// Per a variables simples (Temperatura Actual, Humitat, Pressió)
async function displayVariable(variableKey, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;
    const config = VARIABLES_CONFIG[variableKey];

    const isHistoric = targetDate !== null;
    const timestampToUse = isHistoric ? new Date(targetDate) : findLatestSmcTimestamp(new Date());

    // NOU: Actualitzar el display d'informació
    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'instant',
        timestamp: timestampToUse
    });

    dataMarkersLayer.clearLayers();
    if (!config.special) { convergencesLayer.remove(); }
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);
    
    if (config.special) {
        startWindLayer();
        isLoadingData = false; return;
    }

    const smcResult = await fetchSmcData(config.id, timestampToUse); // Utilitzem el timestamp calculat
    let finalData = smcResult.data;

    if (!isHistoric && config.aemet_id) {
        const aemetRawData = await fetchAemetData();
        if (aemetRawData && aemetRawData.length > 0) {
            const estacionsAemetCat = aemetRawData.filter(d => d.lat >= 40.5 && d.lat <= 42.9 && d.lon >= 0.1 && d.lon <= 3.4);
            if (estacionsAemetCat.length > 0) {
                const ultima = estacionsAemetCat.reduce((max, d) => d.fint > max ? d.fint : max, estacionsAemetCat[0].fint);
                finalData.push(...estacionsAemetCat.filter(d => d.fint === ultima && typeof d[config.aemet_id] !== 'undefined').map(d => ({ source: 'aemet', lat: d.lat, lon: d.lon, nom: d.ubi, valor: d[config.aemet_id] })));
            }
        }
    }
    
    dataMarkersLayer.clearLayers();
    finalData.forEach(estacio => {
      const value = Number(estacio.valor); if (isNaN(value)) return;
        let color;
        switch (config.id) {
            case 33: case 3: case 44: color = getHumidityColor(value); break;
            case 35: color = getSemihorariaPrecipColor(value); break;
            case 72: color = getIntensityColor(value); break;
            case 34: case 1: case 2: color = getPressureColor(value); break;
            case 38: color = getSnowDepthColor(value); break;
            default: color = getTempRgbaColor(value);
        }
        const formattedValue = value.toFixed(config.decimals);
        const icon = L.divIcon({ className: 'temp-label', html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`, iconSize: [30, 18], iconAnchor: [15, 9] });
        L.marker([estacio.lat, estacio.lon], { icon }).bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`).addTo(dataMarkersLayer);
    });
    isLoadingData = false;
}

// Funció auxiliar per a "debounce"
function debounce(func, timeout = 100){
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { func.apply(this, args); }, timeout);
  };
}

// REEMPLAÇA AQUESTA FUNCIÓ
function createLightningPopup() {
    const existingPopup = document.getElementById('lightning-popup');
    if (existingPopup) existingPopup.remove();

    const popup = L.DomUtil.create('div', 'info-popup', map.getContainer());
    popup.id = 'lightning-popup';
    L.DomEvent.disableClickPropagation(popup);

    popup.style.cssText = 'position:absolute; top:80px; left:80px; background:rgba(255,255,255,0.9); padding:10px; border-radius:8px; z-index:1005; box-shadow: 0 2px 10px rgba(0,0,0,0.2); width: 240px;';

    popup.innerHTML = `
        <div style="font-weight:bold; margin-bottom:8px; font-size:14px;">Visualització de Llamps</div>
        <div id="lightning-options-container" style="font-size:13px;">
            <label style="display:block; margin-bottom:5px; cursor:pointer;"><input type="radio" name="lightning-view" value="realtime_only" checked> Només Temps Real</label>
            <label style="display:block; margin-bottom:5px; cursor:pointer;"><input type="radio" name="lightning-view" value="historic"> Temps Real + Històric (120 min)</label>
            <label style="display:block; margin-bottom:5px; cursor:pointer;"><input type="radio" name="lightning-view" value="realtime_plus_1h"> Temps Real + Resum 1h (Tiles)</label>
            <label style="display:block; cursor:pointer;"><input type="radio" name="lightning-view" value="realtime_plus_24h"> Temps Real + Resum 24h (Tiles)</label>
        </div>
        <div id="historic-lightning-controls" style="display: none; margin-top: 10px; border-top: 1px solid #ccc; padding-top: 10px;">
             <label for="historic-lightning-slider" id="historic-lightning-label" style="display: block; margin-bottom: 5px; font-size: 12px; text-align: center;">Últims 120 minuts</label>
             <input type="range" id="historic-lightning-slider" min="5" max="120" step="1" value="120" style="width: 100%;">
        </div>
        <div id="analysis-mode-controls" style="margin-top: 10px; border-top: 1px solid #ccc; padding-top: 10px; font-size:13px;">
            <label style="display:block; cursor:pointer;">
                <input type="checkbox" id="auto-cell-detection-toggle" checked> Detecció Automàtica
            </label>
        </div>
    `;

    const radios = popup.querySelectorAll('input[name="lightning-view"]');
    const historicControls = document.getElementById('historic-lightning-controls');
    const slider = document.getElementById('historic-lightning-slider');
    const sliderLabel = document.getElementById('historic-lightning-label');
    const autoDetectToggle = document.getElementById('auto-cell-detection-toggle');

    radios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) {
                const mode = e.target.value;
                realtimeLightningManager.toggleHistoricLayers(mode);
                historicControls.style.display = (mode === 'historic') ? 'block' : 'none';
                document.getElementById('analysis-mode-controls').style.display = (mode === 'historic') ? 'block' : 'none';
            }
        });
    });

    const debouncedSetTimeFilter = debounce((minutes) => realtimeLightningManager.setTimeFilter(minutes), 100);

    slider.addEventListener('input', (e) => {
        const minutes = parseInt(e.target.value);
        sliderLabel.textContent = `Últims ${minutes} minuts`;
        debouncedSetTimeFilter(minutes);
    });
    
    autoDetectToggle.addEventListener('change', (e) => {
        isAutoDetectMode = e.target.checked;
        toggleAnalysisMode();
    });

    if (realtimeLightningManager.currentMode === 'historic') {
         popup.querySelector('input[value="historic"]').checked = true;
         historicControls.style.display = 'block';
         document.getElementById('analysis-mode-controls').style.display = 'block';
    } else if (realtimeLightningManager.layer1h && map.hasLayer(realtimeLightningManager.layer1h)) {
        popup.querySelector('input[value="realtime_plus_1h"]').checked = true;
    } else if (realtimeLightningManager.layer24h && map.hasLayer(realtimeLightningManager.layer24h)) {
        popup.querySelector('input[value="realtime_plus_24h"]').checked = true;
    }
    
    // Assegurem l'estat inicial correcte de les eines de dibuix
    toggleAnalysisMode();
}

// Per a Velocitat i Ratxa Semihorària
async function displaySimpleWind(config, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;

    const isHistoric = targetDate !== null;
    const timestampToUse = isHistoric ? new Date(targetDate) : findLatestSmcTimestamp(new Date());

    // NOU: Actualitzar el display
    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'simple_wind',
        timestamp: timestampToUse
    });

    dataMarkersLayer.clearLayers(); convergencesLayer.remove();
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);
    const dataType = (config.base_id === 30) ? 'speed' : 'gust';
    const finalData = await fetchAllWindData(dataType, timestampToUse); // Utilitzem el timestamp
    dataMarkersLayer.clearLayers();
    finalData.forEach(estacio => {
        let value = parseFloat(estacio.speed_ms); if (isNaN(value)) return;
        const valueInKmh = value * 3.6;
        const displayValue = value * config.conversion;
        const color = getWindColor(valueInKmh);
        const formattedValue = displayValue.toFixed(config.decimals);
        const icon = L.divIcon({ className: 'temp-label', html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`, iconSize: [30, 18], iconAnchor: [15, 9] });
        L.marker([estacio.lat, estacio.lon], { icon }).bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${valueInKmh.toFixed(1)} km/h (${value.toFixed(1)} m/s)`).addTo(dataMarkersLayer);
    });
    isLoadingData = false;
}

// ===== REEMPLAÇA AQUESTA FUNCIÓ =====
async function displaySummaryVariable(config, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;

    const isHistoric = targetDate !== null;
    const dateForDay = isHistoric ? targetDate : new Date(); 

    // NOU: Actualitzar el display
    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'summary',
        timestamp: dateForDay
    });

    dataMarkersLayer.clearLayers(); convergencesLayer.remove();
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);

    let resultData = [];
    
    const startOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 0, 0, 0, 0));
    const endOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 23, 59, 59, 999));

    if (config.id === 50) { // Ratxa màxima diària
        const gust_ids = [50, 53, 56];
        const promises = gust_ids.map(id => fetchSmcDailySummary(id, 'max', startOfDay, endOfDay));
        const results = await Promise.all(promises);
        const finalGustData = new Map();
        for (const result of results) {
            result.data.forEach(station => { if (!finalGustData.has(station.codi_estacio)) finalGustData.set(station.codi_estacio, station); });
        }
        resultData = Array.from(finalGustData.values());
    } else { // La resta de resums diaris
        const result = await fetchSmcDailySummary(config.id, config.summary, startOfDay, endOfDay);
        resultData = result.data;
    }

    dataMarkersLayer.clearLayers();
    resultData.forEach(estacio => {
        let value = Number(estacio.valor); if (isNaN(value)) return;
        let color;
        switch (config.id) {
            case 3: case 44: color = getHumidityColor(value); break;
            case 1: case 2: color = getPressureColor(value); break;
            case 50: color = getWindColor(value * 3.6); break;
            case 35: color = getDailyPrecipitationColor(value); break;
            case 72: color = getIntensityColor(value); break;
            default: color = getTempRgbaColor(value); break;
        }
        if (config.conversion) { value *= config.conversion; }
        const formattedValue = value.toFixed(config.decimals);
        const icon = L.divIcon({ className: 'temp-label', html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`, iconSize: [30, 18], iconAnchor: [15, 9] });
        L.marker([estacio.lat, estacio.lon], { icon }).bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`).addTo(dataMarkersLayer);
    });
    isLoadingData = false;
}


// Per a les Barbes de Vent
async function displayWindBarb(config, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;

    const isHistoric = targetDate !== null;
    const timestampToUse = isHistoric ? new Date(targetDate) : findLatestSmcTimestamp(new Date());

    // NOU: Actualitzar el display
    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'wind_barb',
        timestamp: timestampToUse
    });

    dataMarkersLayer.clearLayers(); convergencesLayer.remove();
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);
    const finalData = await fetchAllWindData('speed', timestampToUse);
    dataMarkersLayer.clearLayers();
    finalData.forEach(estacio => {
        const { lat, lon, nom, speed_ms, direction } = estacio; if (isNaN(speed_ms) || isNaN(direction)) return;
        const icon = createWindBarbIcon(speed_ms, direction);
        L.marker([lat, lon], { icon }).bindPopup(`<b>${nom}</b><br>Velocitat: ${(speed_ms * 3.6).toFixed(1)} km/h<br>Direcció: ${direction.toFixed(0)}°`).addTo(dataMarkersLayer);
    });
    isLoadingData = false;
}

// Per al Punt de Rosada
async function displayDewPoint(config, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;

    const isHistoric = targetDate !== null;
    const timestampToUse = isHistoric ? new Date(targetDate) : findLatestSmcTimestamp(new Date());

    // NOU: Actualitzar el display
    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'hybrid',
        timestamp: timestampToUse
    });

    dataMarkersLayer.clearLayers(); convergencesLayer.remove();
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);
    
    try {
        const smcPromises = [fetchSmcData(config.smc_sources.temp, timestampToUse), fetchSmcData(config.smc_sources.rh, timestampToUse)];
        const finalPromises = isHistoric ? smcPromises : [...smcPromises, fetchAemetData()];
        const [smcTemp, smcHumidity, aemetRawData] = await Promise.all(finalPromises);
        const finalData = [];
        const smcHumidityMap = new Map(smcHumidity.data.map(d => [d.codi_estacio, d.valor]));
        smcTemp.data.forEach(station => {
            if (smcHumidityMap.has(station.codi_estacio)) {
                const temp = parseFloat(station.valor), rh = parseFloat(smcHumidityMap.get(station.codi_estacio));
                if (isNaN(temp) || isNaN(rh) || rh <= 0) return;
                const log_rh = Math.log(rh / 100), temp_frac = (17.625 * temp) / (243.04 + temp);
                finalData.push({ ...station, valor: (243.04 * (log_rh + temp_frac)) / (17.625 - log_rh - temp_frac) });
            }
        });
        if (!isHistoric && aemetRawData && aemetRawData.length > 0) {
            const estacionsAemetCat = aemetRawData.filter(d => d.lat >= 40.5 && d.lat <= 42.9 && d.lon >= 0.1 && d.lon <= 3.4);
            if (estacionsAemetCat.length > 0) {
                const ultima = estacionsAemetCat.reduce((max, d) => d.fint > max ? d.fint : max, estacionsAemetCat[0].fint);
                finalData.push(...estacionsAemetCat.filter(d => d.fint === ultima && typeof d[config.aemet_id] !== 'undefined').map(d => ({ source: 'aemet', lat: d.lat, lon: d.lon, nom: d.ubi, valor: d[config.aemet_id] })));
            }
        }
        dataMarkersLayer.clearLayers();
        finalData.forEach(estacio => {
            const value = Number(estacio.valor); if (isNaN(value)) return;
            const color = getTempRgbaColor(value);
            const formattedValue = value.toFixed(config.decimals);
            const icon = L.divIcon({ className: 'temp-label', html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`, iconSize: [30, 18], iconAnchor: [15, 9] });
            L.marker([estacio.lat, estacio.lon], { icon }).bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`).addTo(dataMarkersLayer);
        });
    } catch (error) { console.error("Error a displayDewPoint:", error); } 
    finally { isLoadingData = false; }
}

// ===== REEMPLAÇA AQUESTA FUNCIÓ SENCERA =====
async function displayCalculatedVariable(config, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;

    const isHistoric = targetDate !== null;
    const isSummaryBased = config.sources.some(key => {
        const sourceConfig = VARIABLES_CONFIG[key];
        return sourceConfig && sourceConfig.summary;
    });

    // NOU: Lògica per determinar el tipus de càlcul i actualitzar el display
    const displayType = isSummaryBased ? 'calculated_summary' : 'calculated_instant';
    const timestampForDisplay = isHistoric ? targetDate : (isSummaryBased ? new Date() : findLatestSmcTimestamp(new Date()));
    
    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: displayType,
        timestamp: timestampForDisplay
    });

    dataMarkersLayer.clearLayers(); convergencesLayer.remove();
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);

    const dateToFetch = isHistoric ? targetDate : new Date();

    const sourcePromises = config.sources.map(sourceKey => {
        const sourceConfig = VARIABLES_CONFIG[sourceKey];
        if (!sourceConfig) return Promise.resolve(null);

        if (sourceKey === 'wind') {
             return fetchAllWindData('speed', isHistoric ? dateToFetch : null).then(data => ({ key: sourceKey, data }));
        
        } else if (sourceConfig.summary) {
            const startOfDay = new Date(Date.UTC(dateToFetch.getUTCFullYear(), dateToFetch.getUTCMonth(), dateToFetch.getUTCDate(), 0, 0, 0, 0));
            const endOfDay = new Date(Date.UTC(dateToFetch.getUTCFullYear(), dateToFetch.getUTCMonth(), dateToFetch.getUTCDate(), 23, 59, 59, 999));
            return fetchSmcDailySummary(sourceConfig.id, sourceConfig.summary, startOfDay, endOfDay)
                .then(result => ({ key: sourceKey, data: result.data }));

        } else {
             return fetchSmcData(sourceConfig.id, isHistoric ? dateToFetch : null).then(result => ({ key: sourceKey, data: result.data }));
        }
    });

    try {
        const sourceResults = await Promise.all(sourcePromises);
        const mergedDataByStation = new Map();

        sourceResults.forEach(result => {
            if (!result || !result.data) return;
            result.data.forEach(stationData => {
                const stationId = stationData.codi_estacio || `${stationData.lat.toFixed(4)},${stationData.lon.toFixed(4)}`;
                if (!mergedDataByStation.has(stationId)) mergedDataByStation.set(stationId, { nom: stationData.nom, lat: stationData.lat, lon: stationData.lon });
                const station = mergedDataByStation.get(stationId);
                if (result.key === 'wind') {
                    // Les dades de vent ja vénen processades per fetchAllWindData
                    station[result.key] = stationData;
                } else {
                    station[result.key] = parseFloat(stationData.valor);
                }
            });
        });

        dataMarkersLayer.clearLayers();
        mergedDataByStation.forEach((station) => {
            const hasAllData = config.sources.every(sourceKey => station[sourceKey] !== undefined && station[sourceKey] !== null && (typeof station[sourceKey] === 'object' || !isNaN(station[sourceKey])));
            if (hasAllData) {
                if (config.sources.includes('wind') && station.wind.speed_ms !== undefined) {
                    const speed = station.wind.speed_ms;
                    const direction = station.wind.direction;
                    const angleRad = (270 - direction) * (Math.PI / 180);
                    station.wind.u = speed * Math.cos(angleRad);
                    station.wind.v = speed * Math.sin(angleRad);
                }

                const finalValue = config.calculation(station);
                if (finalValue === null || isNaN(finalValue)) return;
                const color = getDynamicColor(finalValue, config.colorScale);
                const formattedValue = finalValue.toFixed(config.decimals);
                const icon = L.divIcon({ className: 'temp-label', html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`, iconSize: [30, 18], iconAnchor: [15, 9] });
                L.marker([station.lat, station.lon], { icon }).bindPopup(`<b>${station.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`).addTo(dataMarkersLayer);
            }
        });
    } catch (error) {
        console.error("Error a displayCalculatedVariable:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error calculant les dades' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

// ===== AFEGIR AQUESTA NOVA FUNCIÓ DE COLORS =====

/**
 * Retorna un color per a l'escala de vent, basat en la velocitat en km/h.
 * @param {number} speedKmh - Velocitat del vent en km/h.
 * @returns {string} El color RGBA calculat.
 */
function getWindColor(speedKmh) {
    const alpha = 1;
    if (speedKmh < 1) return `rgba(200, 200, 200, ${alpha})`;  // Calma (gris)
    if (speedKmh < 10) return `rgba(173, 216, 230, ${alpha})`; // Blau cel
    if (speedKmh < 20) return `rgba(144, 238, 144, ${alpha})`; // Verd clar
    if (speedKmh < 30) return `rgba(152, 251, 152, ${alpha})`; // Verd pàl·lid
    if (speedKmh < 40) return `rgba(255, 255, 0, ${alpha})`;   // Groc
    if (speedKmh < 50) return `rgba(255, 215, 0, ${alpha})`;   // Groc daurat
    if (speedKmh < 60) return `rgba(255, 165, 0, ${alpha})`;   // Taronja
    if (speedKmh < 70) return `rgba(255, 140, 0, ${alpha})`;   // Taronja fosc
    if (speedKmh < 80) return `rgba(255, 69, 0, ${alpha})`;    // Vermell-taronja
    if (speedKmh < 100) return `rgba(255, 0, 0, ${alpha})`;     // Vermell
    if (speedKmh < 120) return `rgba(220, 20, 60, ${alpha})`;   // Carmesí
    return `rgba(199, 21, 133, ${alpha})`; // Magenta
}

/**
 * Retorna un color per a l'escala d'intensitat de precipitació en mm/min.
 */
function getIntensityColor(intensity) {
    if (intensity <= 0) return '#ffffff'; // Transparent per a zero
    if (intensity < 0.5) return "#a1d3fc"; // Molt feble
    if (intensity < 1)   return "#0095f9"; // Feble
    if (intensity < 2)   return "#00c42c"; // Moderada
    if (intensity < 4)   return "#ffee47"; // Forta
    if (intensity < 6)   return "#ff7235"; // Molt forta
    if (intensity < 10)  return "#ff214e"; // Torrencial
    return "#bd30f3";                      // Extrema
}

// =======================================================================
// DUES NOVES ESCALES DE COLORS PER A PRECIPITACIÓ
// =======================================================================

// --- Escala 1: Per al SUMATORI DE PRECIPITACIÓ (la que vas demanar primer) ---
const colors_sumatori = ["#f0f0f0", "#d9e6bf", "#b3cc99", "#8cbf73", "#66b34d", "#4e8c48", "#287233", "#196f99",
                 "#1c50d3", "#2c85ff", "#56a7f0", "#7cd7ff", "#ffed66", "#ffcc33", "#ffaa00", "#ff8800",
                 "#ff5500", "#ff2200", "#cc0000", "#990066", "#d400ff", "#ff99ff", "#e0e0e0", "#b0b0b0",
                 "#808080", "#665544", "#ccb977"];
const values_sumatori = [1, 2, 5, 7, 10, 12, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100, 125, 150, 175, 200, 250, 300, 400, 500];

function getPrecipitationSumColor(mm) {
    for (let i = 0; i < values_sumatori.length; i++) {
        if (mm <= values_sumatori[i]) {
            return colors_sumatori[i] || colors_sumatori[colors_sumatori.length - 1];
        }
    }
    return colors_sumatori[colors_sumatori.length - 1];
}


// --- Escala 2: Per a la PRECIPITACIÓ DIÀRIA (la nova que has demanat) ---
const colors_diaria = [
    "#a1d3fc", "#51b5fa", "#0095f9", "#106e2b", "#008126", "#00c42c", "#44e534",
    "#8fd444", "#91ea32", "#ffee47", "#ecd336", "#fd5523", "#ff7235", "#ff9a67", "#ff486f",
    "#ff214e", "#c30617", "#85030f", "#5b1670", "#bd30f3"
];
const values_diaria = [
    0.1, 0.2, 0.5, 1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 40, 50, 60, 70, 80, 100, 150, 200
];

function getDailyPrecipitationColor(mm) {
    // Cas especial per a pluja inapreciable o zero
    if (mm < values_diaria[0]) {
        return 'ffffff';
    }

    // Com que hi ha 20 colors i 21 valors, iterem fins al penúltim valor
    for (let i = 0; i < values_diaria.length - 1; i++) {
        if (mm <= values_diaria[i+1]) {
            return colors_diaria[i];
        }
    }
    
    // Si el valor és més gran que l'últim llindar, retornem l'últim color.
    return colors_diaria[colors_diaria.length - 1];
}

/**
 * Retorna un color per a l'escala de precipitació semihorària (blocs de 30 min).
 */
function getSemihorariaPrecipColor(mm) {
    if (mm <= 0.1) return '#ffffff'; // Transparent per a pluja inapreciable
    if (mm < 1)   return "#a1d3fc"; // Blau molt clar
    if (mm < 2.5) return "#51b5fa"; // Blau clar
    if (mm < 5)   return "#0095f9"; // Blau
    if (mm < 10)  return "#00c42c"; // Verd
    if (mm < 15)  return "#ffee47"; // Groc
    if (mm < 25)  return "#ff7235"; // Taronja
    if (mm < 40)  return "#ff214e"; // Vermell
    return "#bd30f3";              // Lila per a valors molt alts
}

/**
 * VERSIÓ DEFINITIVA I FINAL
 * Orquestra la visualització del sumatori de precipitació. Aquesta versió demana a l'API
 * el resum de cada dia per separat i després suma els resultats per evitar errors de l'API.
 */
// A pluja_neu.js, reemplaça la funció sencera
async function displayPrecipitationSum() {
    if (isLoadingData) return;

    // Obtenim les dates dels nous camps 'date'
    const startDateInput = document.getElementById('start-date').value;
    const endDateInput = document.getElementById('end-date').value;

    if (!startDateInput || !endDateInput) {
        alert("Si us plau, selecciona una data d'inici i de fi.");
        return;
    }

    // Convertim les dates a objectes Date. El navegador les interpreta a mitjanit en hora local.
    // Per assegurar que incloem el dia de fi sencer, l'ajustem al final del dia.
    const startDate = new Date(startDateInput);
    const endDate = new Date(endDateInput);

    if (startDate >= endDate) {
        alert("La data d'inici ha de ser anterior a la data de fi.");
        return;
    }
    
    // Ajustem l'hora de la data de fi per incloure el dia sencer (fins a les 23:59:59 UTC)
    endDate.setUTCHours(23, 59, 59, 999);

    isLoadingData = true;
    dataMarkersLayer.clearLayers();
    convergencesLayer.remove();
    L.marker(map.getCenter(), {
      icon: L.divIcon({ className: 'loading-icon', html: `Processant dades...` })
    }).addTo(dataMarkersLayer);

    try {
        const promises = [];
        let loopDate = new Date(startDate);

        while (loopDate <= endDate) {
            const startOfDay = new Date(Date.UTC(loopDate.getUTCFullYear(), loopDate.getUTCMonth(), loopDate.getUTCDate()));
            const endOfDay = new Date(Date.UTC(loopDate.getUTCFullYear(), loopDate.getUTCMonth(), loopDate.getUTCDate(), 23, 59, 59, 999));
            
            promises.push(fetchSmcDailySummary(35, 'sum', startOfDay, endOfDay));
            
            loopDate.setDate(loopDate.getDate() + 1);
        }

        const dailyResults = await Promise.all(promises);

        const finalSums = new Map();
        for (const dayResult of dailyResults) {
            if (dayResult && dayResult.data) {
                for (const stationData of dayResult.data) {
                    const stationCode = stationData.codi_estacio;
                    const dailyValue = parseFloat(stationData.valor);
                    if (!isNaN(dailyValue)) {
                        const currentTotal = finalSums.get(stationCode) || 0;
                        finalSums.set(stationCode, currentTotal + dailyValue);
                    }
                }
            }
        }
        
        dataMarkersLayer.clearLayers();

        if (finalSums.size === 0) {
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'No hi ha dades per a aquest interval' }) }).addTo(dataMarkersLayer);
            setTimeout(() => dataMarkersLayer.clearLayers(), 3000);
            return;
        }

        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60";
        const metadata = await $.getJSON(urlMetadades);
        const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));

        finalSums.forEach((totalSum, stationCode) => {
            const estacioInfo = estacionsMap.get(stationCode);
            if (estacioInfo && totalSum > 0) { // Només mostrem si la suma és major que 0
                const color = getPrecipitationSumColor(totalSum);
                const formattedValue = totalSum.toFixed(1);
                const icon = L.divIcon({
                    className: 'temp-label',
                    html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                    iconSize: [30, 18],
                    iconAnchor: [15, 9]
                });
                L.marker([estacioInfo.lat, estacioInfo.lon], { icon: icon })
                    .bindPopup(`<b>${estacioInfo.nom}</b><br>Suma Precipitació: ${formattedValue} mm`)
                    .addTo(dataMarkersLayer);
            }
        });

    } catch (error) {
        console.error("Error al mostrar el sumatori de precipitació:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error en la consulta' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

/**
 * Crea una icona de fletxa/barba de vent en SVG que apunta a la direcció on VA el vent.
 * AQUESTA VERSIÓ TÉ LES BARBES MÉS AMPLES PER A MÉS VISIBILITAT.
 * @param {number} speed_ms - Velocitat del vent en metres per segon.
 * @param {number} direction - Direcció meteorològica del vent (d'on ve).
 * @returns {L.DivIcon} La icona de Leaflet.
 */
function createWindBarbIcon(speed_ms, direction) {
    const speedKmh = speed_ms * 3.6;
    const color = getWindColor(speedKmh); // Assumint que tens la funció getWindColor
    const knots = speed_ms * 1.94384;

    let barbs = '';
    let p = { x: -50, y: 0 }; 
    let remainingKnots = Math.round(knots / 5) * 5;

    // Banderoles de 50 nusos (més amples)
    while (remainingKnots >= 50) {
        // CANVI: La y passa de -12 a -18 per fer el triangle més ample
        barbs += `<path d="M ${p.x} 0 L ${p.x + 12} -18 L ${p.x} -18 Z" stroke-width="5.0" stroke="black" fill="${color}" />`;
        p.x += 14;
        remainingKnots -= 50;
    }
    // Barbes de 10 nusos (més amples)
    while (remainingKnots >= 10) {
        // CANVI: La y passa de -12 a -18 per fer la línia més ampla
        barbs += `<line x1="${p.x}" y1="0" x2="${p.x + 12}" y2="-18" stroke="black" stroke-width="6.0" />`;
        barbs += `<line x1="${p.x}" y1="0" x2="${p.x + 12}" y2="-18" stroke="${color}" stroke-width="3.5" />`;
        p.x += 8;
        remainingKnots -= 10;
    }
    // Mitja barba de 5 nusos (més ampla)
    if (remainingKnots >= 5) {
        // CANVI: La y passa de -6 a -9 (la meitat de -18) per fer la línia més ampla
        barbs += `<line x1="${p.x}" y1="0" x2="${p.x + 6}" y2="-9" stroke="black" stroke-width="6.0" />`;
        barbs += `<line x1="${p.x}" y1="0" x2="${p.x + 6}" y2="-9" stroke="${color}" stroke-width="3.5" />`;
    }
    
    const rotation = direction - 90;

    // El viewBox anterior hauria de seguir sent suficient, però el mantenim ample per seguretat.
    const svg = `
        <div class="wind-barb-icon-wrapper">
            <svg class="wind-barb-svg" viewBox="-65 -35 130 70" style="transform: rotate(${rotation}deg);">
                
                <line x1="0" y1="0" x2="-50" y2="0" stroke="black" stroke-width="6.0" />
                <line x1="0" y1="0" x2="-50" y2="0" stroke="${color}" stroke-width="3.5" />
                
                <g stroke-linecap="round">
                    ${barbs}
                </g>
            </svg>
        </div>`;

    return L.divIcon({
        html: svg,
        className: 'wind-barb-icon-container',
        iconSize: [60, 60],
        iconAnchor: [30, 30]
    });
}

/**
 * VERSIÓ CORREGIDA I ROBUSTA
 * Mostra la variació d'una variable entre dos punts en el temps.
 * @param {object} config - La configuració de la variable.
 * @param {Date | null} targetDate - La data per a la consulta històrica, o null per al mode en directe.
 */
// ===== REEMPLAÇA AQUESTA FUNCIÓ =====
async function displayVariation(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;

    const isHistoric = targetDate !== null;
    const dateForDay = isHistoric ? targetDate : new Date();

    // NOU: Actualitzar el display
    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'variation',
        timestamp: dateForDay
    });

    dataMarkersLayer.clearLayers();
    convergencesLayer.remove();
    const loadingMarker = L.marker(map.getCenter(), {
      icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` })
    }).addTo(dataMarkersLayer);

    let todayDataRaw, yesterdayDataRaw;
    
    try {
        if (config.comparison === 'daily_summary') {
            const startOfToday = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 0, 0, 0, 0));
            const endOfToday = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 23, 59, 59, 999));
            const startOfYesterday = new Date(startOfToday.getTime() - (24 * 60 * 60 * 1000));
            const endOfYesterday = new Date(endOfToday.getTime() - (24 * 60 * 60 * 1000));
            
            [todayDataRaw, yesterdayDataRaw] = await Promise.all([
                fetchSmcDailySummary(config.base_id, config.summary, startOfToday, endOfToday),
                fetchSmcDailySummary(config.base_id, config.summary, startOfYesterday, endOfYesterday)
            ]);

        } else { // 'instant'
            const timestampAvui = isHistoric ? roundToSemiHourly(new Date(targetDate)) : findLatestSmcTimestamp(new Date());
            const timestampAhir = new Date(timestampAvui.getTime() - (24 * 60 * 60 * 1000));
            
            const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60";
            const metadata = await $.getJSON(urlMetadades);
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));

            const [todayValues, yesterdayValues] = await Promise.all([
                fetchSmcInstant(config.base_id, timestampAvui),
                fetchSmcInstant(config.base_id, timestampAhir)
            ]);
            
            const processInstantData = (data) => data.map(d => ({ ...d, ...estacionsMap.get(d.codi_estacio) })).filter(d => d.lat);
            todayDataRaw = { data: processInstantData(todayValues) };
            yesterdayDataRaw = { data: processInstantData(yesterdayValues) };
        }
        
        if (!todayDataRaw || !yesterdayDataRaw || todayDataRaw.data.length === 0 || yesterdayDataRaw.data.length === 0) {
            throw new Error("Una de les dues consultes (avui o ahir) no ha retornat dades.");
        }

        const todayValuesMap = new Map(todayDataRaw.data.map(d => [d.codi_estacio, parseFloat(d.valor || d.valor_lectura)]));
        const finalData = yesterdayDataRaw.data.map(estacioAhir => {
            const codiEstacio = estacioAhir.codi_estacio;
            if (todayValuesMap.has(codiEstacio)) {
                const valorAvui = todayValuesMap.get(codiEstacio);
                const valorAhir = parseFloat(estacioAhir.valor || estacioAhir.valor_lectura);
                if (!isNaN(valorAvui) && !isNaN(valorAhir)) {
                    return { ...estacioAhir, valor: valorAvui - valorAhir };
                }
            }
            return null;
        }).filter(d => d !== null);

        dataMarkersLayer.clearLayers();

        if (finalData.length === 0) {
             L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'No hi ha dades coincidents' }) }).addTo(dataMarkersLayer);
        }

        finalData.forEach(estacio => {
            const value = Number(estacio.valor);
            if (isNaN(value)) return;
            const color = getTempRgbaColor(value);
            const formattedValue = (value > 0 ? '+' : '') + value.toFixed(config.decimals);
            const icon = L.divIcon({
                className: 'temp-label',
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                iconSize: [30, 18],
                iconAnchor: [15, 9]
            });
            L.marker([estacio.lat, estacio.lon], { icon: icon })
                .bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`)
                .addTo(dataMarkersLayer);
        });

    } catch (error) {
        console.error("Error a displayVariation:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error carregant les dades' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

// ===================================================================
// SECCIÓ DE LA CAPA DE VENT (VERSIÓ NETA I REFACTORITZADA)
// ===================================================================

const convergencesLayer = L.layerGroup();
let windArrowsLayer = L.layerGroup();
let areArrowsVisible = true;
let velocityLayer = null;
let isLoadingWind = false;
let windUpdateInterval = null;

// --- Funcions de càrrega de dades (Globals) ---

async function loadAemetData() {
    const apiKey = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5wb25zYUBnbWFpbC5jb20iLCJqdGkiOiI1OTZhMjQ3MC0zODg2LTRkNzktOTE3OC01NTA5MDI5Y2MwNjAiLCJpc3MiOiJBRU1FVCIsImlhdCI6MTUyMTA0OTg0MywidXNlcklkIjoiNTk2YTI0NzAtMzg4Ni00ZDc5LTkxNzgtNTUwOTAyOWNjMDYwIiwicm9sZSI6IiJ9.rmsBWXYts5VUBXKlErX7i9W0e3Uz-sws33bgRcIvlug";
    const urlInicial = 'https://opendata.aemet.es/opendata/api/observacion/convencional/todas';
    try {
        const res1 = await fetch(urlInicial, { headers: { 'api_key': apiKey, 'accept': 'application/json' }});
        const info = await res1.json();
        if (info.estado !== 200) throw new Error(info.descripcion);
        const res2 = await fetch(info.datos);
        const rawData = await res2.json();
        return processAemetData(rawData);
    } catch (error) { 
        console.error("Error AEMET:", error); 
        return { data: [], timestamp: null }; 
    }
}

function processAemetData(data) {
    const BBOX_CAT = { minLat: 40.5, maxLat: 42.9, minLon: 0.1, maxLon: 3.4 };
    const estacionsCat = data.filter(d => d.lat >= BBOX_CAT.minLat && d.lat <= BBOX_CAT.maxLat && d.lon >= BBOX_CAT.minLon && d.lon <= BBOX_CAT.maxLon);
    if (estacionsCat.length === 0) return { data: [], timestamp: null };
    const ultimaDataAemet = estacionsCat.reduce((max, d) => d.fint > max ? d.fint : max, estacionsCat[0].fint);
    const dadesFinals = estacionsCat.filter(d => d.fint === ultimaDataAemet);
    const processedData = dadesFinals.map(estacio => {
        if (typeof estacio.vv === 'undefined' || typeof estacio.dv === 'undefined') return null;
        const speed = estacio.vv;
        const direction = estacio.dv;
        const angleRad = (270 - direction) * (Math.PI / 180);
        return { lat: estacio.lat, lon: estacio.lon, u: speed * Math.cos(angleRad), v: speed * Math.sin(angleRad), nom: estacio.ubi };
    }).filter(d => d !== null);
    return { data: processedData, timestamp: ultimaDataAemet };
}

function loadSmcData() {
    return new Promise((resolve) => {
        const targetTimestamp = findLatestSmcTimestamp(new Date());
        const yyyy = targetTimestamp.getUTCFullYear();
        const mm = String(targetTimestamp.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(targetTimestamp.getUTCDate()).padStart(2, '0');
        const hh = String(targetTimestamp.getUTCHours()).padStart(2, '0');
        const mi = String(targetTimestamp.getUTCMinutes()).padStart(2, '0');
        const finalTimestampString = `${yyyy}-${mm}-${dd}T${hh}:${mi}:00.000`;
        
        console.log(`[VENT] Demanant dades SMC per a les: ${finalTimestampString}`);
        
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";

        $.getJSON(urlMetadades).done(metadata => {
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));
            const variableCodes = [30, 31, 46, 47, 48, 49];
            const requests = variableCodes.map(code => {
                const url = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?data_lectura=${finalTimestampString}&codi_variable=${code}`;
                return $.getJSON(url).catch(() => null);
            });

            $.when(...requests).done((...responses) => {
                const datasets = responses.map(r => r ? r[0] : null);
                const smcWindData = processSmcData(datasets, estacionsMap);
                resolve({ data: smcWindData, timestamp: finalTimestampString });
            });
        }).fail(() => resolve({ data: [], timestamp: null }));
    });
}

function processSmcData(datasets, estacionsMap) {
    const [wind10m, dir10m, wind2m, dir2m, wind6m, dir6m] = datasets;
    const allWind = [wind10m, wind6m, wind2m];
    const allDir = [dir10m, dir6m, dir2m];
    const processedStations = new Set();
    const smcWindData = [];

    allWind.forEach((windBlock, idx) => {
        if (!windBlock) return;
        const dirBlock = allDir[idx];
        if (!dirBlock) return;
        const dirMap = new Map(dirBlock.map(d => [d.codi_estacio, parseFloat(d.valor_lectura)]));

        windBlock.forEach(w => {
            const stationCode = w.codi_estacio;
            if (processedStations.has(stationCode) || !dirMap.has(stationCode)) return;
            const estacioInfo = estacionsMap.get(stationCode);
            if (estacioInfo) {
                const speed = parseFloat(w.valor_lectura);
                const direction = dirMap.get(stationCode);
                const angleRad = (270 - direction) * (Math.PI / 180);
                smcWindData.push({ lat: estacioInfo.lat, lon: estacioInfo.lon, u: speed * Math.cos(angleRad), v: speed * Math.sin(angleRad), codi_estacio: stationCode, nom: estacioInfo.nom });
                processedStations.add(stationCode);
            }
        });
    });
    return smcWindData;
}


// --- Funcions de visualització del vent ---

function displayCombinedWindData(combinedData) {
    convergencesLayer.clearLayers();
    windArrowsLayer.clearLayers();

    if (combinedData.length === 0) {
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: 'Dades de vent no disponibles' }) }).addTo(convergencesLayer);
        return;
    }

    const latitudep = Array.from({length: 25}, (_, i) => 42.9 - i * 0.1);
    const longitudep = Array.from({length: 37}, (_, i) => 0.1 + i * 0.1);
    
    function haversine(lat1, lon1, lat2, lon2) {
        const R = 6371e3;
        const φ1 = lat1 * Math.PI/180;
        const φ2 = lat2 * Math.PI/180;
        const Δφ = (lat2-lat1) * Math.PI/180;
        const Δλ = (lon2-lon1) * Math.PI/180;
        const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) / 1000;
    }
    
    function interpolateWindData(uData, vData, latEst, lonEst) {
        const valorx = [], valory = [];
        for (let j = 0; j < latitudep.length; j++) {
            for (let k = 0; k < longitudep.length; k++) {
                let sumU = 0, sumV = 0, sumW = 0;
                for (let i = 0; i < latEst.length; i++) {
                    const d = haversine(latitudep[j], longitudep[k], latEst[i], lonEst[i]);
                    if (d < 50) { // Radi d'influència
                        const w = 1 / Math.pow(d, 3); // Ponderació per distància
                        sumU += uData[i] * w; sumV += vData[i] * w; sumW += w;
                    }
                }
                valorx.push(sumW ? sumU / sumW : 0);
                valory.push(sumW ? sumV / sumW : 0);
            }
        }
        return { valorx, valory };
    }

    const latData = combinedData.map(d => d.lat);
    const lonData = combinedData.map(d => d.lon);
    const u = combinedData.map(d => d.u);
    const v = combinedData.map(d => d.v);
    const { valorx, valory } = interpolateWindData(u, v, latData, lonData);

    const header = { parameterUnit: "m.s-1", la1: latitudep[0], lo1: longitudep[0], dx: 0.1, dy: 0.1, nx: longitudep.length, ny: latitudep.length };
    const windgbr = [{ header: { ...header, parameterCategory: 2, parameterNumber: 2 }, data: valorx }, { header: { ...header, parameterCategory: 2, parameterNumber: 3 }, data: valory }];

    velocityLayer = L.velocityLayer({
        displayValues: true, data: windgbr, minVelocity: 0, maxVelocity: 25,
        velocityScale: 0.010, particleAge: 1200, lineWidth: 2, particleMultiplier: 1/50,
        colorScale: ["#000000"]
    });
    convergencesLayer.addLayer(velocityLayer);

    combinedData.forEach(d => {
        if (d.u === 0 && d.v === 0) return;
        const magnitude = Math.sqrt(d.u**2 + d.v**2);
        const u_norm = d.u / magnitude, v_norm = d.v / magnitude;
        const line = L.polyline([[d.lat, d.lon], [d.lat + v_norm * 0.08, d.lon + u_norm * 0.08]], { color: 'black', weight: 1.5, opacity: 0.8 });
        const decorator = L.polylineDecorator(line, { patterns: [{ offset: '100%', repeat: 0, symbol: L.Symbol.arrowHead({ pixelSize: 10, polygon: false, pathOptions: { stroke: true, weight: 1.5, color: 'black', opacity: 0.8 }}) }] });
        windArrowsLayer.addLayer(line).addLayer(decorator);
    });

    if (areArrowsVisible) {
        convergencesLayer.addLayer(windArrowsLayer);
    }
}

// --- Funció principal i controladors d'esdeveniments de la capa de vent ---

function startWindLayer() {
    if (isLoadingWind) return;
    isLoadingWind = true;
    console.log("Iniciant càrrega de dades de vent...");

    if (!velocityLayer) {
        convergencesLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: 'Carregant dades de vent...' }) }).addTo(convergencesLayer);
    }
    
    Promise.all([loadSmcData(), loadAemetData()]).then(([smcResult, aemetResult]) => {
        let allData = [];
        const smcTime = smcResult.timestamp ? new Date(smcResult.timestamp + 'Z').getTime() : 0;
        const aemetTime = aemetResult.timestamp ? new Date(aemetResult.timestamp).getTime() : 0;

        if (smcTime > 0) {
            allData.push(...smcResult.data);
            if (aemetTime > 0 && Math.abs(smcTime - aemetTime) < 30 * 60 * 1000) {
                allData.push(...aemetResult.data);
            }
        } else if (aemetTime > 0) {
            allData.push(...aemetResult.data);
        }
        
        displayCombinedWindData(allData);
        isLoadingWind = false;
    }).catch(() => { isLoadingWind = false; });
}

convergencesLayer.on('add', function() {
    startWindLayer();
    if (windUpdateInterval) clearInterval(windUpdateInterval);
    windUpdateInterval = setInterval(startWindLayer, 15 * 60 * 1000);
});

convergencesLayer.on('remove', function() {
    if (windUpdateInterval) { clearInterval(windUpdateInterval); windUpdateInterval = null; }
    if (velocityLayer || isLoadingWind) { 
        convergencesLayer.clearLayers(); 
        velocityLayer = null; 
        isLoadingWind = false; 
    }
});

// ===================================================================
// FI DE LA NOVA CAPA DE VENT
// ===================================================================

const dataMarkersLayer = L.layerGroup().addTo(map);

// Control de capes
L.control.layers(baseLayers, {
  "Convergències Vent": convergencesLayer, // <-- NOVA CAPA AFEGIDA AQUÍ
  "PoN sense corregir": plujaneu_layer,
  "CAPPI sense corregir": radar_layer,
  "Zones Perill Allaus": wmsLayer,
  "Live Cams": camerasLayer,
  "Comarques": comarquesLayer,
  "Municipis": municipisGeojsonLayer, // Nom de variable corregit
  "Xarxa Hidrogràfica": xarxaHidrograficaLayer
}, {
  position: 'topright',
  collapsed: true
}).addTo(map);



const sumatoriControls = document.getElementById('sumatori-controls');

// AFEGEIX AQUEST BLOC NOU
document.getElementById('lightning-btn').addEventListener('click', function() {
    // Si ja està actiu, l'aturem. Si no, l'activem.
    if (realtimeLightningManager.isActive) {
        realtimeLightningManager.stop();
        // Opcional: torna a mostrar una capa per defecte, per exemple la temperatura.
        displayVariable('smc_32');
    } else {
        stopAllDataLayers(); // Aturem qualsevol altra capa de dades
        realtimeLightningManager.start(); // Iniciem el gestor de llamps
        createLightningPopup(); // Creem el seu menú d'opcions
    }
});

// Listener per al menú principal
document.getElementById('meteo-controls').addEventListener('click', function(event) {
        if (event.target.closest('#historic-controls-container')) {
        return;
    }
    
    const target = event.target.closest('[data-variable-key]');
    if (!target) return;
    
    event.preventDefault();
    sumatoriControls.style.display = 'none'; // Amaga el panell del sumatori per defecte

    document.querySelectorAll('#meteo-controls li, #meteo-controls a').forEach(el => el.classList.remove('active'));
    
    let activeElement = target.closest('li') || target;
    if (activeElement) {
        activeElement.classList.add('active');
        const mainMenuItem = activeElement.closest('.main-menu-item');
        if (mainMenuItem) mainMenuItem.querySelector('a').classList.add('active');
    }

    const variableKey = target.dataset.variableKey;

    // Lògica per mostrar el panell del sumatori
    if (variableKey === 'sumatori_precipitacio') {
        sumatoriControls.style.display = 'flex';
        dataMarkersLayer.clearLayers(); // Neteja el mapa
        convergencesLayer.remove();
        return; // Atura l'execució aquí
    }

    const config = VARIABLES_CONFIG[variableKey];
    if (!config) return;

    if (!config.special) { convergencesLayer.remove(); }
    
    const dateToUse = historicModeTimestamp;

    // LÒGICA DE DECISIÓ DEFINITIVA
    if (config.comparison) {
        displayVariation(config, dateToUse);
    } else if (config.summary) {
        displaySummaryVariable(config, dateToUse);
    } else if (config.isWindBarb) {
        displayWindBarb(config, dateToUse);
    } else if (config.isSimpleWind) {
        displaySimpleWind(config, dateToUse);
    } else if (config.isHybrid) {
        displayDewPoint(config, dateToUse);
    } else if (config.isCalculated) {
        displayCalculatedVariable(config, dateToUse);
    } else {
        displayVariable(variableKey, dateToUse); 
    }
});

// Listeners per als botons del panell del sumatori
document.getElementById('calculate-sum-btn').addEventListener('click', displayPrecipitationSum);

document.getElementById('close-sum-btn').addEventListener('click', () => {
    sumatoriControls.style.display = 'none';
});

/**
 * REFRESCA LA VISTA AMB LA VARIABLE ACTUALMENT SELECCIONADA
 * Aquesta funció s'activa quan es canvia la data en mode històric.
 */
function refreshCurrentVariableView() {
    // Troba l'element del menú que està actiu per saber quina variable mostrar
    const activeMenuItem = document.querySelector('#meteo-controls .submenu li.active[data-variable-key]');
    
    if (!activeMenuItem) {
        // Si no hi ha cap variable seleccionada, no fa res.
        // Això pot passar al carregar la pàgina inicialment.
        // La variable per defecte es carrega per separat.
        return;
    }
    
    const variableKey = activeMenuItem.dataset.variableKey;
    const config = VARIABLES_CONFIG[variableKey];

    if (!config) {
        console.error(`Configuració no trobada per a la clau: ${variableKey}`);
        return;
    }

    // Aquesta lògica és un clon de la que hi ha a l'event 'click' del menú.
    // Determina quina funció de visualització ha de cridar.
    const dateToUse = historicModeTimestamp; // Sempre utilitza la data del mode històric

    if (config.comparison) {
        displayVariation(config, dateToUse);
    } else if (config.summary) {
        displaySummaryVariable(config, dateToUse);
    } else if (config.isWindBarb) {
        displayWindBarb(config, dateToUse);
    } else if (config.isSimpleWind) {
        displaySimpleWind(config, dateToUse);
    } else if (config.isHybrid) {
        displayDewPoint(config, dateToUse);
    } else if (config.isCalculated) {
        displayCalculatedVariable(config, dateToUse);
    } else {
        // Cas per defecte per a variables simples (ex: Temperatura Actual)
        displayVariable(variableKey, dateToUse); 
    }
}

/**
 * Arrodoneix un objecte Date a l'interval de 30 minuts anterior més proper (xx:00 o xx:30).
 * @param {Date} date - L'objecte Date per arrodonir.
 * @returns {Date} L'objecte Date ja arrodonit.
 */
function roundToSemiHourly(date) {
    const minutes = date.getUTCMinutes(); // Canviat a getUTCMinutes
    date.setUTCSeconds(0, 0);             // Canviat a setUTCSeconds
    if (minutes >= 30) {
        date.setUTCMinutes(30);           // Canviat a setUTCMinutes
    } else {
        date.setUTCMinutes(0);            // Canviat a setUTCMinutes
    }
    return date;
}

/**
 * Funció centralitzada per actualitzar el text d'informació de temps.
 * Aquesta versió mostra els intervals de 30 minuts tant en mode directe com en històric
 * per a les dades semihoràries, i mostra la data per als resums diaris.
 */
function updateHistoricDisplay(info) {
    const display = document.getElementById('historic-time-display');

    if (!info || !info.timestamp) {
        display.textContent = 'MODE DIRECTE';
        return;
    }

    const d = info.timestamp;
    const dateString = `${fillTo(d.getUTCDate(), 2)}/${fillTo(d.getUTCMonth() + 1, 2)}/${d.getUTCFullYear()}`;

    // La lògica principal ara es basa en el tipus de dada
    switch (info.type) {
        case 'instant':
        case 'wind_barb':
        case 'simple_wind':
        case 'hybrid':
        case 'calculated_instant':
            // Aquestes són dades d'interval (semihoràries)
            const startTime = d;
            const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // Afegeix 30 minuts
            const startTimeString = `${fillTo(startTime.getUTCHours(), 2)}:${fillTo(startTime.getUTCMinutes(), 2)}`;
            const endTimeString = `${fillTo(endTime.getUTCHours(), 2)}:${fillTo(endTime.getUTCMinutes(), 2)}`;

            if (info.mode === 'historic') {
                // En mode històric, incloem la data a la descripció de l'interval
                display.textContent = `Interval ${dateString} ${startTimeString} - ${endTimeString} UTC`;
            } else { // Mode 'live'
                display.textContent = `Dades interval ${startTimeString} - ${endTimeString} UTC`;
            }
            break;

        case 'summary':
        case 'variation':
        case 'calculated_summary':
            // Aquestes són dades de resum diari. La presentació és la mateixa en directe i en històric.
            display.textContent = `Dades del ${dateString}`;
            break;

        default:
            // Fallback per a qualsevol cas no contemplat
            display.textContent = 'MODE DIRECTE';
    }
}


// ======================================================
// LÒGICA FINAL PER ALS CONTROLS DE TEMPS A LA BARRA SUPERIOR
// ======================================================

const historicControls = document.getElementById('historic-controls-container');
const historicDisplay = document.getElementById('historic-time-display');
const historicPicker = document.getElementById('historic-datetime-picker');
const timeButtons = historicControls.querySelectorAll('.time-buttons button');
const returnLiveBtn = document.getElementById('time-return-live');

// Funció CLAU: Activa o desactiva els botons segons si estem en mode històric
// Funció CLAU: Activa o desactiva els botons segons si estem en mode històric
function updateControlState() {
    const isHistoric = historicModeTimestamp !== null;

    if (isHistoric) {
        returnLiveBtn.classList.add('active');
        returnLiveBtn.textContent = 'DIRECTE'; // Canviem el text per claredat
        returnLiveBtn.title = 'Tornar al Directe';
        // El text del display ara s'actualitza des de les funcions display...
    } else {
        returnLiveBtn.classList.remove('active');
        returnLiveBtn.textContent = 'DIRECTE';
        returnLiveBtn.title = 'Estàs en mode directe';
        // El text del display també s'actualitza des de les funcions display...
    }
}

// ======================================================
// SOLUCIÓ NATIVA I DEFINITIVA PER OBRIR EL CALENDARI
// ======================================================

document.getElementById('historic-calendar-btn').addEventListener('click', function () {
    const historicPicker = document.getElementById('historic-datetime-picker');

    // La funció moderna per obrir el selector de forma explícita
    if (historicPicker.showPicker) {
        try {
            console.log("Intentant obrir el calendari amb showPicker()...");
            historicPicker.showPicker();
        } catch (error) {
            // Aquesta alternativa pot funcionar si showPicker() falla per alguna raó
            console.error("showPicker() ha fallat. Provant amb focus(). Error:", error);
            historicPicker.focus();
        }
    } else {
        // Si el navegador és antic i no suporta showPicker(),
        // intentem el mètode de 'focus', que a vegades funciona.
        console.log("showPicker() no suportat. Provant amb focus()...");
        historicPicker.focus();
    }
});

// AQUEST ÉS EL NOU CODI CORREGIT
function moveTimeAndUpdate(minutes) {
    // Si estem en mode directe, el primer clic estableix l'hora
    // actual com a punt de partida, ja convertida a UTC i arrodonida.
    if (historicModeTimestamp === null) {
        historicModeTimestamp = roundToSemiHourly(new Date());
    }

    // Ara, apliquem el canvi de temps utilitzant UTC
    historicModeTimestamp.setUTCMinutes(historicModeTimestamp.getUTCMinutes() + minutes);
    
    // No cal tornar a arrodonir aquí, ja que els salts són de 30 minuts
    // historicModeTimestamp = roundToSemiHourly(historicModeTimestamp);

    // I finalment, refresquem la vista i els controls
    refreshCurrentVariableView();
    updateControlState();
}


// --- Assignació d'esdeveniments als botons ---

document.getElementById('time-jump-back-24h').addEventListener('click', () => moveTimeAndUpdate(-24 * 60));
document.getElementById('time-step-back').addEventListener('click', () => moveTimeAndUpdate(-30));
document.getElementById('time-step-fwd').addEventListener('click', () => moveTimeAndUpdate(30));
document.getElementById('time-jump-fwd-24h').addEventListener('click', () => moveTimeAndUpdate(24 * 60));


historicPicker.addEventListener('change', () => {
    if (historicPicker.value) {
        // AFEGIM 'Z' AL FINAL DEL STRING.
        // Això força al constructor de Date a interpretar el temps com a UTC,
        // ignorant la zona horària local del navegador.
        historicModeTimestamp = roundToSemiHourly(new Date(historicPicker.value + 'Z'));
        
        updateControlState();
        refreshCurrentVariableView();
    }
});

returnLiveBtn.addEventListener('click', () => {
    if (historicModeTimestamp !== null) {
        historicModeTimestamp = null;
        updateControlState();
        refreshCurrentVariableView(); // Això cridarà la funció display corresponent, que actualitzarà el text
    }
});


/* ======================================================
   Event Listeners i funcions addicionals
   ====================================================== */
document.getElementById('play-button').addEventListener('click', toggleAnimation);
document.getElementById('gif-button').addEventListener('click', createGIF);

// Actualització automàtica cada minut
setInterval(() => {
    setRangeValues();
    timeDependentLayers.forEach(layer => {
      if (map.hasLayer(layer)) layer.refresh();
    });
    setDateText(range_values[range_element.value]);
  }, 60000);

// Funció per alternar l'animació
function toggleAnimation() {
    const playButton = document.getElementById('play-button');
    isPlaying = !isPlaying;
    playButton.textContent = isPlaying ? '⏸️' : '▶️';

    if (isPlaying) {
      function frame() {
        if (!isPlaying) return;
        let currentStep = parseInt(range_element.value);
        currentStep = (currentStep >= max_range_steps - 1) ? 0 : currentStep + 1;
        range_element.value = currentStep;
        const event = new Event('input');
        range_element.dispatchEvent(event);
        const delay = (currentStep === max_range_steps - 1) ? pauseOnLastFrame : animationSpeed;
        animationInterval = setTimeout(frame, delay);
      }
      frame();
    } else {
      clearTimeout(animationInterval);
    }
}

// Funció i event listener per al botó de les fletxes
function toggleWindArrows() {
    areArrowsVisible = !areArrowsVisible;
    const btn = document.getElementById('toggle-arrows-btn');
    btn.classList.toggle('inactive', !areArrowsVisible);

    if (areArrowsVisible) {
        if (map.hasLayer(convergencesLayer)) {
            convergencesLayer.addLayer(windArrowsLayer);
        }
    } else {
        if (convergencesLayer.hasLayer(windArrowsLayer)) {
            convergencesLayer.removeLayer(windArrowsLayer);
        }
    }
}
document.getElementById('toggle-arrows-btn').addEventListener('click', toggleWindArrows);

// Funció per crear el GIF (utilitzant html2canvas)
function createGIF() {
    if (captureInProgress) return;
    captureInProgress = true;

    if (isPlaying) toggleAnimation();

    const targetWidth = document.documentElement.clientWidth;
    const targetHeight = document.documentElement.clientHeight;

    gif = new GIF({
      workers: 2,
      quality: 4,
      width: targetWidth,
      height: targetHeight,
      transparent: 0xFFFFFFFF,
      workerScript: gifWorkerUrl
    });

    let currentStep = 0;
    const originalValue = range_element.value;

    async function captureFrame() {
      if (currentStep >= totalGifFrames) {
        gif.render();
        return;
      }

      map.dragging.disable();
      map.zoomControl.disable();
      map.scrollWheelZoom.disable();

      range_element.value = currentStep;
      timeDependentLayers.forEach(layer => { if (map.hasLayer(layer)) layer.refresh(); });
      setDateText(range_values[currentStep]);

      await new Promise(resolve => setTimeout(resolve, 300));

      try {
        const canvas = await html2canvas(document.documentElement, {
          useCORS: true, logging: true, windowWidth: targetWidth, windowHeight: targetHeight, scale: 1
        });
        gif.addFrame(canvas, { delay: gifFrameDelay });
        updateProgress((++currentStep / totalGifFrames) * 100);
        captureFrame();
      } catch (error) {
        console.error("Error:", error);
        captureInProgress = false;
      } finally {
        map.dragging.enable();
        map.zoomControl.enable();
        map.scrollWheelZoom.enable();
      }
    }

    captureFrame();

    gif.on('finished', (blob) => {
      range_element.value = originalValue;
      timeDependentLayers.forEach(layer => { if (map.hasLayer(layer)) layer.refresh(); });
      setDateText(range_values[originalValue]);

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'animacio-meteo.gif';
      a.click();
      URL.revokeObjectURL(url);
      captureInProgress = false;
    });
}

// Modificar l'event de canvi de capa base per opacitat
map.on('baselayerchange', function(event) {
    const isBlanc = event.layer === baseLayers.Blanc;
    timeDependentLayers.forEach(layer => {
      if (map.hasLayer(layer)) {
          layer.setOpacity(isBlanc ? 1 : 0.85);
      }
    });
  });



// Substitueix el teu bloc 'DOMContentLoaded' per aquest:
document.addEventListener('DOMContentLoaded', function() {
    const llegendaPluja = document.querySelector('.legend');
    const llegendaRadar = document.querySelector('.llegenda');
    const closeButtons = document.querySelectorAll('.close-legend');

    if (!llegendaPluja || !llegendaRadar) {
        console.error("Un o més elements de la llegenda no s'han trobat a l'HTML!");
        return;
    }

    function updateLegendsVisibility() {
        const plujaVisible = map.hasLayer(plujaneu_layer);
        const radarVisible = map.hasLayer(radar_layer);
        llegendaPluja.style.display = plujaVisible ? 'block' : 'none';
        llegendaRadar.style.display = radarVisible ? 'block' : 'none';
    }

    plujaneu_layer.on('add remove', updateLegendsVisibility);
    radar_layer.on('add remove', updateLegendsVisibility);

    // LÒGICA CORREGIDA PER AL BOTÓ DE TANCAR
    closeButtons.forEach(button => {
        button.addEventListener('click', function() {
            // LA CORRECCIÓ ÉS AQUÍ:
            // Busquem l'ancestre més proper que sigui una llegenda i l'amaguem.
            const legendToClose = this.closest('.legend, .llegenda');
            if (legendToClose) {
                legendToClose.style.display = 'none';
            }
        });
    });

    // La funció per arrossegar les llegendes es manté igual
    function makeDraggable(element) {
        let isDragging = false, offsetX, offsetY;
        function startDrag(e) {
            if (e.target.classList.contains('close-legend')) return;
            isDragging = true;
            const rect = element.getBoundingClientRect();
            const clientX = e.clientX || e.touches[0].clientX;
            const clientY = e.clientY || e.touches[0].clientY;
            offsetX = clientX - rect.left;
            offsetY = clientY - rect.top;
            element.style.position = 'fixed';
            element.style.bottom = 'auto';
            element.style.right = 'auto';
            document.addEventListener('mousemove', drag);
            document.addEventListener('mouseup', stopDrag);
            document.addEventListener('touchmove', drag, { passive: false });
            document.addEventListener('touchend', stopDrag);
            e.preventDefault();
        }
        function drag(e) {
            if (!isDragging) return;
            const clientX = e.clientX || e.touches[0].clientX;
            const clientY = e.clientY || e.touches[0].clientY;
            element.style.left = `${clientX - offsetX}px`;
            element.style.top = `${clientY - offsetY}px`;
        }
        function stopDrag() {
            isDragging = false;
            document.removeEventListener('mousemove', drag);
            document.removeEventListener('mouseup', stopDrag);
            document.removeEventListener('touchmove', drag);
            document.removeEventListener('touchend', stopDrag);
        }
        element.addEventListener('mousedown', startDrag);
        element.addEventListener('touchstart', startDrag);
    }

    makeDraggable(llegendaPluja);
    makeDraggable(llegendaRadar);

    updateLegendsVisibility();
});

// ======================================================
// FUNCIONALITAT PER AL NOU BOTÓ DE NETEJA
// ======================================================

document.getElementById('clear-data-btn').addEventListener('click', function() {
    // 1. Esborra totes les etiquetes de dades del mapa.
    // Aquesta és la capa on s'afegeixen les temperatures, precipitacions, etc.
    dataMarkersLayer.clearLayers();

    // 2. Desmarca qualsevol opció que estigués activa al menú superior.
    document.querySelectorAll('#meteo-controls li.active, #meteo-controls a.active').forEach(el => {
        el.classList.remove('active');
    });

    console.log("S'han netejat les etiquetes del mapa.");
});



// ======================================================
// LÒGICA PER AL SISTEMA D'ALERTES DE TEMPS SEVER (VERSIÓ CORREGIDA)
// ======================================================

document.addEventListener('DOMContentLoaded', function() {
    const alertPanel = document.getElementById('alert-panel');
    const alertBtn = document.getElementById('alert-btn');
    const closeAlertBtn = document.getElementById('close-alert-panel');
    const intensityBtn = document.getElementById('alert-intensity-btn');
    const accumulationBtn = document.getElementById('alert-accumulation-btn');

    if (alertPanel && alertBtn && closeAlertBtn && intensityBtn && accumulationBtn) {
        
        // Lògica per mostrar/amagar el panell
        alertBtn.addEventListener('click', () => {
            const isVisible = alertPanel.style.display === 'block';
            alertPanel.style.display = isVisible ? 'none' : 'block';
        });

        closeAlertBtn.addEventListener('click', () => {
            alertPanel.style.display = 'none';
        });

        // ASSIGNEM ELS BOTONS A LA NOVA FUNCIÓ UNIFICADA
        intensityBtn.addEventListener('click', () => displayAlerts('alert_intensity'));
        accumulationBtn.addEventListener('click', () => displayAlerts('alert_accumulation'));

        console.log("Sistema d'alertes (versió corregida) inicialitzat correctament.");

    } else {
        console.error("Un o més elements del panell d'alertes no s'han trobat a l'HTML.");
    }
});

/**
 * VERSIÓ DEFINITIVA I UNIFICADA PER MOSTRAR ALERTES (AMB MODE HISTÒRIC I DISSENY UNIFICAT)
 * Mostra alertes de precipitació (intensitat o acumulació) basant-se en una configuració.
 * @param {string} variableKey - La clau de la variable d'alerta ('alert_intensity' o 'alert_accumulation').
 */
async function displayAlerts(variableKey) {
    if (isLoadingData) return;
    isLoadingData = true;

    const config = VARIABLES_CONFIG[variableKey];
    if (!config) {
        console.error(`Configuració d'alerta no trobada per a: ${variableKey}`);
        isLoadingData = false;
        return;
    }

    dataMarkersLayer.clearLayers();
    document.getElementById('alert-panel').style.display = 'none';
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Buscant ${config.name}...` }) }).addTo(dataMarkersLayer);

    // <-- CANVI CLAU 1: INTEGRACIÓ AMB EL MODE HISTÒRIC -->
    // Comprovem si estem en mode històric. Si no, utilitzem la data actual.
    const dateForQuery = historicModeTimestamp || new Date();

    const startOfDay = new Date(Date.UTC(dateForQuery.getUTCFullYear(), dateForQuery.getUTCMonth(), dateForQuery.getUTCDate(), 0, 0, 0, 0));
    const endOfDay = new Date(Date.UTC(dateForQuery.getUTCFullYear(), dateForQuery.getUTCMonth(), dateForQuery.getUTCDate(), 23, 59, 59, 999));

    try {
        const result = await fetchSmcDailySummary(config.id, config.summary, startOfDay, endOfDay);
        const stationsInAlert = result.data.filter(station => parseFloat(station.valor) >= config.alertThreshold);

        if (stationsInAlert.length === 0) {
            dataMarkersLayer.clearLayers();
            const friendlyDate = `${dateForQuery.getDate()}/${dateForQuery.getMonth() + 1}/${dateForQuery.getFullYear()}`;
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `No hi ha alertes per a la data ${friendlyDate}.` }) }).addTo(dataMarkersLayer);
            setTimeout(() => dataMarkersLayer.clearLayers(), 3500);
            return;
        }

        dataMarkersLayer.clearLayers();
        stationsInAlert.forEach(estacio => {
            const estacioInfo = { lat: estacio.lat, lon: estacio.lon, nom: estacio.nom };
            const value = parseFloat(estacio.valor);

            if (estacioInfo && !isNaN(value)) {
                const color = (config.summary === 'max') ? getSemihorariaPrecipColor(value) : getDailyPrecipitationColor(value);
                
                // <-- CANVI CLAU 2: DISSENY DE L'ETIQUETA UNIFICAT -->
                // Utilitzem les mateixes propietats que la resta de marcadors de dades.
                const icon = L.divIcon({
                    className: 'temp-label', // Classe estàndard
                    html: `<div style="background-color: ${color}; width: 100%; height: 100%; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${value.toFixed(1)}</div>`,
                    iconSize: [30, 18],     // Mida estàndard
                    iconAnchor: [15, 9]      // Ancoratge estàndard
                });

                const popupTitle = (config.summary === 'max') ? "Intensitat Màxima (30min)" : "Acumulació Diària";

                // Mantenim la paraula "ALERTA" al popup per donar context
                L.marker([estacioInfo.lat, estacioInfo.lon], { icon })
                    .bindPopup(`<b>${estacioInfo.nom}</b><br><span style="color:red; font-weight:bold;">ALERTA</span><br>${popupTitle}: <b>${value.toFixed(1)} mm</b>`)
                    .addTo(dataMarkersLayer);
            }
        });

    } catch (error) {
        console.error(`Error buscant alertes per ${config.name}:`, error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error en la consulta d\'alertes' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

let analisisPolygon = null; // Variable global per guardar el polígon actiu
let lightningChart = null;  // Variable global per al gràfic

/**
 * Analitza una sèrie de recomptes i retorna un array amb la posició
 * i la intensitat (sigma) dels salts que superen un llindar determinat.
 * @param {number[]} recomptes - Array de recomptes (ara en intervals de 2 min).
 * @param {number} sigmaThreshold - El llindar de desviacions estàndard per a considerar un salt (p. ex., 2.0 o 1.5).
 * @returns {Array} - Un array amb els objectes dels salts detectats.
 */
function detectarSaltsHistòrics(recomptes, sigmaThreshold = 2.0) {
    const saltsDetectats = [];
    const periodeCalculBins = 6; 
    const minLlampsPerBin = 10;   

    for (let i = periodeCalculBins; i < recomptes.length; i++) {
        const dadesReferencia = recomptes.slice(i - periodeCalculBins, i);
        
        // CORRECCIÓ AQUÍ: La funció 'reduce' ara suma correctament els valors.
        const suma = dadesReferencia.reduce((a, b) => a + b, 0);
        const mitjana = suma / dadesReferencia.length;

        if (mitjana < 1) continue;

        const diferenciaQuadrada = dadesReferencia.map(valor => Math.pow(valor - mitjana, 2));
        const variancia = diferenciaQuadrada.reduce((a, b) => a + b, 0) / dadesReferencia.length;
        const desviacioEstandard = Math.sqrt(variancia);

        if (desviacioEstandard < 1) continue;

        const llindar = mitjana + (sigmaThreshold * desviacioEstandard);
        const valorActual = recomptes[i];

        if (valorActual > llindar && valorActual >= minLlampsPerBin) {
            const sigma = (valorActual - mitjana) / desviacioEstandard;
            saltsDetectats.push({ index: i, sigma: sigma });
        }
    }
    return saltsDetectats;
}

/**
 * Fusiona les dades històriques amb les de temps real per tenir un conjunt de dades complet.
 */
function getCombinedLightningData() {
    const combinedStrikes = new Map();
    const now = Date.now();
    const timeCutoff = now - (120 * 60 * 1000); // Finestra fixa de 120 minuts

    // 1. Afegeix les dades històriques (que ja estan dins de la finestra de 120 min)
    realtimeLightningManager.historicStrikes.forEach((strike, id) => {
        combinedStrikes.set(id, strike);
    });

    // 2. Afegeix NOMÉS les dades en temps real que siguin més recents que 120 minuts
    realtimeLightningManager.strikeMarkers.forEach((markerData, id) => {
        if (markerData.timestamp >= timeCutoff) {
            const strikeId = `rt-${id}`;
            if (!combinedStrikes.has(strikeId)) {
                combinedStrikes.set(strikeId, {
                    lat: markerData.marker.getLatLng().lat,
                    lon: markerData.marker.getLatLng().lng,
                    timestamp: markerData.timestamp
                });
            }
        }
    });

    return combinedStrikes;
}

// ===================================================================
// NOU SISTEMA AUTOMÀTIC DE DETECCIÓ DE LIGHTNING JUMP (Basat en F17)
// ===================================================================

// Capa de Leaflet per dibuixar les cèl·lules detectades
const cellulesTempestaLayer = L.layerGroup({ pane: 'poligonsPane' }).addTo(map);
const ljIconsLayer = L.layerGroup({ pane: 'iconesPane' }).addTo(map);


/**
 * 1. RASTERITZACIÓ: Converteix una llista de llamps en una graella.
 * @param {Map} historicStrikes - El mapa de llamps històrics.
 * @param {number} resolution - La mida de cada cel·la de la graella (en graus).
 * @returns {Map} - Un mapa on cada clau és "lat_lon" i el valor és un array de llamps.
 */
function rasteritzarLlamps(historicStrikes, resolution = 0.03) { // CANVI: Resolució més fina (~1x1 km)
    const grid = new Map();
    historicStrikes.forEach(llamp => {
        const gridX = Math.floor(llamp.lon / resolution);
        const gridY = Math.floor(llamp.lat / resolution);
        const key = `${gridX}_${gridY}`;

        if (!grid.has(key)) {
            grid.set(key, { strikes: [], coords: { lon: gridX * resolution, lat: gridY * resolution } });
        }
        grid.get(key).strikes.push(llamp);
    });
    return grid;
}

/**
 * 2. IDENTIFICACIÓ DE CÈL·LULES (VERSIÓ REFINADA)
 * Agrupa píxels actius adjacents amb un llindar de llamps més baix.
 */
function identificarCelules(grid) {
    const celules = [];
    const visited = new Set();

    grid.forEach((value, key) => {
        if (!visited.has(key) && value.strikes.length > 1) { 
            const novaCelula = {
                id: `cell-${Date.now()}-${celules.length}`,
                strikes: [],
                pixels: []
            };
            const queue = [key];
            visited.add(key);

            while (queue.length > 0) {
                const currentKey = queue.shift();
                const [x, y] = currentKey.split('_').map(Number);
                
                novaCelula.strikes.push(...grid.get(currentKey).strikes);
                novaCelula.pixels.push(grid.get(currentKey).coords);

                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        if (dx === 0 && dy === 0) continue;
                        const neighborKey = `${x + dx}_${y + dy}`;
                        if (grid.has(neighborKey) && !visited.has(neighborKey) && grid.get(neighborKey).strikes.length > 1) {
                            visited.add(neighborKey);
                            queue.push(neighborKey);
                        }
                    }
                }
            }
            
            // CANVI CLAU: Reduïm el llindar de 20 a 10 per a més sensibilitat
            if (novaCelula.strikes.length > 10) {
                celules.push(novaCelula);
            }
        }
    });
    return celules;
}

/**
 * 3. ANÀLISI PER CÈL·LULA: Aplica el detector de LJ a cada cèl·lula.
 * @param {Array} celules - L'array de cèl·lules de tempesta.
 * @returns {Array} - El mateix array, però amb la informació de l'anàlisi afegida.
 */
function analitzarCadaCelula(celules, totesLesDades) {
    const now = Date.now();
    const totalMinutes = 120;
    const bins = totalMinutes / 2;
    const tempsLimitActivitat = now - (20 * 60 * 1000);

    // Es prepara cada cèl·lula per a l'anàlisi
    celules.forEach(cell => {
        cell.pixelKeys = new Set(cell.pixels.map(p => {
            const gridX = Math.floor(p.lon / 0.01);
            const gridY = Math.floor(p.lat / 0.01);
            return `${gridX}_${gridY}`;
        }));
        cell.recomptesComplets = new Array(bins).fill(0);
    });

    // S'omplen els recomptes de llamps per a cada cèl·lula
    totesLesDades.forEach(llamp => {
        const ageMinutes = Math.floor((now - llamp.timestamp) / 60000);
        if (ageMinutes < totalMinutes) {
            const gridX = Math.floor(llamp.lon / 0.01);
            const gridY = Math.floor(llamp.lat / 0.01);
            const key = `${gridX}_${gridY}`;
            const cellCorresponent = celules.find(c => c.pixelKeys.has(key));
            if (cellCorresponent) {
                const binIndex = bins - 1 - Math.floor(ageMinutes / 2);
                if (binIndex >= 0 && binIndex < bins) {
                    cellCorresponent.recomptesComplets[binIndex]++;
                }
            }
        }
    });

    // S'executa l'anàlisi de salts per a cada cèl·lula
    celules.forEach(cell => {
        cell.esActiva = cell.strikes.some(llamp => llamp.timestamp >= tempsLimitActivitat);
        
        // CORRECCIÓ: Ja no apliquem el filtre de 'compleixLlindarActivitat' aquí.
        // La funció 'detectarSaltsHistòrics' ja conté el seu propi llindar d'intensitat.
        cell.saltN1 = detectarSaltsHistòrics(cell.recomptesComplets, 1.5);
        cell.saltN2 = detectarSaltsHistòrics(cell.recomptesComplets, 2.0);
    });

    return celules;
}


/**
 * VERSIÓ FINAL: Dibuixa les cèl·lules actives, mostra la seva trajectòria,
 * i manté un estat visual per a aquelles que han tingut un LJ en el passat.
 */
function visualitzarCelules(celulesAnalitzades) {
    cellulesTempestaLayer.clearLayers();
    ljIconsLayer.clearLayers();
    const ljIcon = L.icon({ iconUrl: 'imatges/LJ.png', iconSize: [35, 35], iconAnchor: [17, 17], popupAnchor: [0, -17] });

    celulesAnalitzades.forEach(cell => {
        const teSaltN2Històric = cell.saltN2.length > 0;
        const teSaltN1Històric = cell.saltN1.length > 0;
        
        if (!cell.esActiva && !teSaltN1Històric && !teSaltN2Històric) { return; }

        const points = cell.pixels.map(p => [p.lon, p.lat]);
        if (points.length < 3) return;
        const featureCollection = turf.featureCollection(points.map(p => turf.point(p)));
        const hull = turf.convex(featureCollection);
        if (!hull) return;

        // Finestra per a considerar un salt "actiu" (últims 15-20 minuts)
        const llindarIndexRecent = 50; 
        
        const saltN2Actiu = cell.saltN2.some(s => s.index >= llindarIndexRecent);
        const saltN1Actiu = cell.saltN1.some(s => s.index >= llindarIndexRecent);
        
        let estilPoligon, popupText, mostraIcona = false;
        
        if (saltN2Actiu) {
            estilPoligon = { color: '#ff0000', weight: 3, fillOpacity: 0.4 };
            popupText = `<b><span style="color:red;">LJ Sever (N2) ACTIU</span></b>`;
            mostraIcona = true;
        } else if (saltN1Actiu) {
            estilPoligon = { color: '#ff8c00', weight: 2, fillOpacity: 0.35 };
            popupText = `<b><span style="color:darkorange;">LJ Sensible (N1) ACTIU</span></b>`;
            mostraIcona = true;
        } else if (teSaltN2Històric) {
            estilPoligon = { color: '#8b0000', weight: 1, fillOpacity: 0.2, dashArray: '10, 10' };
            popupText = `<b>Estat: Post-Salt Sever (N2)</b>`;
        } else if (teSaltN1Històric) {
            estilPoligon = { color: '#b5651d', weight: 1, fillOpacity: 0.2, dashArray: '10, 10' };
            popupText = `<b>Estat: Post-Salt Sensible (N1)</b>`;
        } else {
            popupText = `<b>Estat: Activa</b>`;
            estilPoligon = { color: '#0095f9', weight: 2, fillOpacity: 0.2 };
        }

        const poligonLayer = L.geoJSON(hull, { style: estilPoligon });
        
        const recompteUltims10min = cell.recomptesComplets.slice(-5).reduce((a, b) => a + b, 0);
        const popupContent = `
            <b>Cèl·lula de Tempesta</b><br>
            ${popupText}<br>
            <hr style="margin: 4px 0;">
            Llamps (últims 20 min): <b>${cell.strikes.length}</b><br>
            Llamps (últims 10 min): <b>${recompteUltims10min}</b>
            <br><em>(Fes clic per veure l'historial)</em>
        `;
        
        // AFEGIT EL CODI QUE FALTAVA
        poligonLayer.bindPopup(popupContent).on('click', () => {
             const labels = Array.from({ length: 60 }, (_, i) => `-${120 - i*2}m`);
             const saltsCombinats = [...cell.saltN2, ...cell.saltN1];
             mostrarGrafic(labels, cell.recomptesComplets, saltsCombinats);
        });
        cellulesTempestaLayer.addLayer(poligonLayer);

        // AFEGIT EL CODI QUE FALTAVA
        if (cell.trajectoria && cell.trajectoria.length > 1) {
            const trajectoriaLatLng = cell.trajectoria.map(coords => [coords[1], coords[0]]);
            L.polyline(trajectoriaLatLng, { color: 'white', weight: 2, opacity: 0.7, dashArray: '5, 5' }).addTo(cellulesTempestaLayer);
        }

        // AFEGIT EL CODI QUE FALTAVA
        if (mostraIcona) {
            // Aquesta línia estava a la teva versió anterior del codi i s'havia perdut
            if (!cell.centroide) cell.centroide = turf.centroid(hull);

            const centroidCoords = [cell.centroide.geometry.coordinates[1], cell.centroide.geometry.coordinates[0]];
            L.marker(centroidCoords, { icon: ljIcon })
                .addTo(ljIconsLayer)
                .bindPopup(popupContent)
                .on('click', () => {
                    const labels = Array.from({ length: 60 }, (_, i) => `-${120 - i*2}m`);
                    const saltsCombinats = [...cell.saltN2, ...cell.saltN1];
                    mostrarGrafic(labels, cell.recomptesComplets, saltsCombinats);
                });
        }
    });
}

/**
 * Compares current cells with previous ones to give them
 * a persistent identity (tracking).
 * @param {Array} celulesActuals - The cells detected in the current minute.
 * @param {Array} celulesAnteriors - The cells from the previous analysis.
 * @returns {Array} The current cells with their history and ID inherited.
 */
function ferSeguimentDeCelules(celulesActuals, celulesAnteriors) {
    // CORRECCIÓ: Ens assegurem que totes les cèl·lules, noves o velles, tinguin un centroide
    celulesActuals.forEach(actual => {
        if (!actual.centroide) { // Comprovem si ja en té abans de calcular
            actual.centroide = turf.centroid(turf.featureCollection(actual.pixels.map(p => turf.point([p.lon, p.lat]))));
        }
    });

    if (celulesAnteriors.length === 0) {
        celulesActuals.forEach(actual => {
            actual.trajectoria = [actual.centroide.geometry.coordinates];
        });
        return celulesActuals;
    }

    const celulesSeguides = celulesActuals.map(actual => {
        let millorCandidat = null;
        let distanciaMinima = Infinity;

        celulesAnteriors.forEach(anterior => {
            // Assegurem que la cèl·lula anterior també té centroide
            if (!anterior.centroide) return;
            const distancia = turf.distance(actual.centroide, anterior.centroide);
            if (distancia < distanciaMinima) {
                distanciaMinima = distancia;
                millorCandidat = anterior;
            }
        });
        
        if (millorCandidat && distanciaMinima < 20) {
            actual.id = millorCandidat.id;
            const baseTrajectoria = Array.isArray(millorCandidat.trajectoria) ? millorCandidat.trajectoria : [];
            actual.trajectoria = [...baseTrajectoria, actual.centroide.geometry.coordinates];
        } else {
            actual.trajectoria = [actual.centroide.geometry.coordinates];
        }
        return actual;
    });

    return celulesSeguides;
}

/**
 * FUNCIÓ ORQUESTRADORA PRINCIPAL (VERSIÓ REFINADA)
 * Executa el procés filtrant primer per llamps recents.
 */
function analitzarTempestesSMC() {
    console.log("Iniciant anàlisi de cèl·lules ACTIVES amb reconstrucció de trajectòria...");
    const dadesCompletes = getCombinedLightningData();

    const now = Date.now();
    const tempsLimit = now - (20 * 60 * 1000); // Finestra de 20 min per identificar
    
    const llampsRecents = new Map();
    dadesCompletes.forEach((llamp, id) => {
        if (llamp.timestamp >= tempsLimit) {
            llampsRecents.set(id, llamp);
        }
    });
    
    const graella = rasteritzarLlamps(llampsRecents);
    const celules = identificarCelules(graella);
    
    const celulesAnalitzades = analitzarCadaCelula(celules, dadesCompletes);
    visualitzarCelules(celulesAnalitzades);
    
    console.log(`Anàlisi completada. S'han trobat ${celulesAnalitzades.length} cèl·lules actives.`);
}

/**
 * VERSIÓ FINAL: Analitza un polígon dibuixat manualment utilitzant
 * el mateix motor d'anàlisi que el sistema automàtic.
 */
function analitzarLightningJump() {
    if (!analisisPolygon) {
        // Si per alguna raó no hi ha polígon, amaguem el gràfic.
        document.getElementById('lightning-jump-overlay').style.display = 'none';
        return;
    }

    console.log("Iniciant anàlisi en mode MANUAL amb el nou algorisme...");

    // 1. Obtenim TOTES les dades (històriques + temps real)
    const dadesCompletes = getCombinedLightningData();

    // 2. Filtrem els llamps que cauen dins del polígon manual
    const llampsDinsDelPoligon = [];
    dadesCompletes.forEach(llamp => {
        const punt = turf.point([llamp.lon, llamp.lat]);
        if (turf.booleanPointInPolygon(punt, analisisPolygon)) {
            llampsDinsDelPoligon.push(llamp);
        }
    });

    // 3. Creem una "cèl·lula de tempesta virtual" amb els llamps filtrats
    //    Li donem una estructura semblant a les cèl·lules automàtiques.
    const celulaManual = {
        strikes: llampsDinsDelPoligon,
        // Definim els píxels a partir dels llamps per poder fer l'anàlisi retrospectiva
        pixels: llampsDinsDelPoligon.map(l => ({ lon: l.lon, lat: l.lat }))
    };

    // 4. Utilitzem el NOU motor d'anàlisi sobre aquesta cèl·lula virtual
    // Passem un array amb la nostra única cèl·lula i les dades completes
    const celulaAnalitzada = analitzarCadaCelula([celulaManual], dadesCompletes)[0];

    // 5. Mostrem el gràfic amb els resultats de l'anàlisi actualitzada
    const labels = Array.from({ length: 60 }, (_, i) => `-${120 - i*2}m`);
    const saltsCombinats = [...celulaAnalitzada.saltN2, ...celulaAnalitzada.saltN1];
    mostrarGrafic(labels, celulaAnalitzada.recomptesComplets, saltsCombinats);
}

/**
 * VERSIÓ FINAL: Dibuixa el gràfic, gestiona els colors per intensitat,
 * la icona de llamp i la interactivitat de la finestra.
 */
function mostrarGrafic(labels, data, saltsDetectats = []) {
    if (lightningChart) {
        lightningChart.destroy();
    }

    const overlay = document.getElementById('lightning-jump-overlay');
    const container = document.getElementById('lightning-jump-chart-container');
    overlay.style.display = 'flex';
    const ctx = document.getElementById('lightningJumpChart').getContext('2d');

    function getColorPerSalt(sigma) {
        if (sigma >= 4) return { bg: 'rgba(189, 48, 243, 0.7)', border: 'rgba(189, 48, 243, 1)' };
        if (sigma >= 3) return { bg: 'rgba(255, 20, 20, 0.7)', border: 'rgba(255, 20, 20, 1)' };
        return { bg: 'rgba(255, 114, 53, 0.7)', border: 'rgba(255, 114, 53, 1)' };
    }

    const saltsMap = new Map(saltsDetectats.map(s => [s.index, s.sigma]));
    const backgroundColors = data.map((_, index) => saltsMap.has(index) ? getColorPerSalt(saltsMap.get(index)).bg : 'rgba(0, 149, 249, 0.5)');
    const borderColors = data.map((_, index) => saltsMap.has(index) ? getColorPerSalt(saltsMap.get(index)).border : 'rgba(0, 149, 249, 1)');

    lightningChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Llamps per minut dins la zona',
                data: data,
                backgroundColor: backgroundColors,
                borderColor: borderColors,
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { ticks: { maxRotation: 90, minRotation: 90, autoSkip: true, maxTicksLimit: 20 } },
                y: { beginAtZero: true, title: { display: true, text: 'Nre. de llamps' } }
            },
            plugins: {
                legend: { display: false },
                lightningJumpIcon: { jumps: saltsDetectats }
            }
        }
    });

    document.getElementById('close-chart-btn').onclick = () => {
        overlay.style.display = 'none';
        container.classList.remove('modal-view');
        if (lightningChart) {
            lightningChart.destroy();
            lightningChart = null;
        }
    };
    
    document.getElementById('toggle-chart-size-btn').onclick = () => {
        container.classList.toggle('modal-view');
    };
}



/**
 * Funció de descompressió LZW per a les dades de Blitzortung.org.
 * Aquesta funció converteix la cadena de text ofuscada en un JSON llegible.
 */
function lzw_decode(str) {
    let dict = {};
    let data = (str + "").split("");
    let currChar = data[0];
    let oldPhrase = currChar;
    let out = [currChar];
    let code = 256;
    let phrase;
    for (let i = 1; i < data.length; i++) {
        let currCode = data[i].charCodeAt(0);
        if (currCode < 256) {
            phrase = data[i];
        } else {
            phrase = dict[currCode] ? dict[currCode] : (oldPhrase + currChar);
        }
        out.push(phrase);
        currChar = phrase.charAt(0);
        dict[code] = oldPhrase + currChar;
        code++;
        oldPhrase = phrase;
    }
    return out.join("");
}

// ===================================================================
// GESTOR DE LLAMPS EN TEMPS REAL I HISTÒRIC (VERSIÓ DEFINITIVA)
// Reemplaça tot el teu objecte 'realtimeLightningManager' per aquest.
// ===================================================================
const realtimeLightningManager = {
    isActive: false,
    currentMode: 'realtime_only',
    // Propietats per als dos sockets
    socketLm: null, // Per a LightningMaps.org
    socketBo: null, // Per a Blitzortung.org
    strikeMarkers: new Map(),
    updateInterval: null,
    layerGroup: L.layerGroup({ pane: 'llampsPane' }),

    // Propietats per a les dades històriques i les capes de resum
    historicStrikes: new Map(),
    historicLayerGroup: L.layerGroup({ pane: 'llampsPane' }),
    historicUpdateInterval: null,
    timeFilterMinutes: 120,
    layer1h: null,
    layer24h: null,
    MAX_AGE_MINS: 30,

    // Inicia el mòdul de llamps i connecta a les dues fonts
    start: function() {
        if (this.isActive) return;
        console.log("Iniciant mòdul de llamps (amb dues fonts)...");
        this.isActive = true;
        this.layerGroup.addTo(map);
        this.historicLayerGroup.addTo(map);
        this.connect();
        this.updateInterval = setInterval(() => this.updateMarkers(), 5000);
    },

    // Atura el mòdul i tanca les dues connexions
    stop: function() {
        if (!this.isActive) return;
        console.log("Aturant mòdul de llamps.");
        this.isActive = false;
        if (this.socketLm) this.socketLm.close();
        if (this.socketBo) this.socketBo.close();
        this.socketLm = null;
        this.socketBo = null;

        if (this.updateInterval) clearInterval(this.updateInterval);
        this.updateInterval = null;
        
        this.strikeMarkers.clear();
        this.layerGroup.clearLayers();
        map.removeLayer(this.layerGroup);

        this.toggleHistoricLayers('none');
        const popup = document.getElementById('lightning-popup');
        if (popup) popup.remove();
    },

    // Funció orquestradora que inicia les dues connexions
    connect: function() {
        this.connectLightningMaps();
        this.connectBlitzortung();
    },

    // Connexió a LightningMaps.org (sense canvis)
    connectLightningMaps: function() {
        // ... (Aquesta funció es queda exactament com estava)
        if (this.socketLm && this.socketLm.readyState < 2) return;
        const wsUrl = 'wss://live2.lightningmaps.org:443/';
        this.socketLm = new WebSocket(wsUrl);
        this.socketLm.onopen = () => {
            console.log("WS LightningMaps: Connectat.");
            this.sendBoundsSubscription();
        };
        this.socketLm.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.k) {
                this.socketLm.send(`{"k":${(data.k*3604)%7081*new Date().getTime()/100}}`);
                return;
            }
            if (data.strokes) data.strokes.forEach(s => this.addStrike(s));
        };
        this.socketLm.onclose = () => console.log("WS LightningMaps: Tancat.");
        this.socketLm.onerror = (error) => console.error("WS LightningMaps Error:", error);
    },

    // VERSIÓ CORREGIDA per connectar-se a Blitzortung.org
    connectBlitzortung: function() {
        if (this.socketBo && this.socketBo.readyState < 2) return;
        const wsUrl = 'wss://ws1.blitzortung.org/';
        this.socketBo = new WebSocket(wsUrl);
        
        // PISTA 1: Enviar un missatge de salutació (handshake) en connectar
        this.socketBo.onopen = () => {
            console.log("WS Blitzortung: Connectat.");
            this.socketBo.send('{"a":111}');
        };
        
        this.socketBo.onmessage = (event) => {
            // PISTA 2: Descomprimir les dades abans de processar-les
            const decompressedData = lzw_decode(event.data);
            const rawData = JSON.parse(decompressedData);

            // Aquesta funció ara rebrà el JSON net
            const decodedStrike = this.decodeBlitzortungStrike(rawData);
            if (decodedStrike) {
                this.addStrike(decodedStrike);
            }
        };
        this.socketBo.onclose = () => console.log("WS Blitzortung: Tancat.");
        this.socketBo.onerror = (error) => console.error("WS Blitzortung Error:", error);
    },
    
    // Funció per extreure les dades del JSON ja descomprimit
    decodeBlitzortungStrike: function(data) {
        // El JSON descomprimit té claus normals: 'lat', 'lon', 'time', etc.
        if (data.lat !== undefined && data.lon !== undefined) {
            const id = `bo-${data.time}-${data.lat}-${data.lon}`;
            return {
                id: id,
                lat: data.lat,
                lon: data.lon
            };
        }
        return null;
    },

    // Funció unificada per afegir qualsevol llamp al mapa
addStrike: function(strike) {
    if (this.strikeMarkers.has(strike.id) || !strike.lat || !strike.lon) return;

    // CORRECCIÓ: Especifiquem el 'pane' correcte aquí
    const flashStyle = { radius: 30, fillColor: "#FFFFFF", fillOpacity: 0.8, weight: 0, pane: 'llampsPane' };
    
    const marker = L.circleMarker([strike.lat, strike.lon], flashStyle);
    const markerData = { marker: marker, timestamp: new Date().getTime() };
    this.strikeMarkers.set(strike.id, markerData);
    this.layerGroup.addLayer(marker);
    
    setTimeout(() => { if (this.strikeMarkers.has(strike.id)) this.updateMarkerStyle(markerData, 0); }, 250);
    this.createExpandingCircle(strike.lat, strike.lon);
},

    // Funcions per a la visualització dels llamps en temps real
updateMarkers: function() {
    const now = new Date().getTime();
    
    // El temps màxim de vida ara depèn del valor del slider quan el mode històric està actiu
    // Si no està en mode històric, es manté el màxim de 30 minuts.
    const maxAgeMins = this.currentMode === 'historic' ? this.timeFilterMinutes : this.MAX_AGE_MINS;

    this.strikeMarkers.forEach((markerData, strikeId) => {
        const ageMins = (now - markerData.timestamp) / 60000;
        if (ageMins > maxAgeMins) {
            this.layerGroup.removeLayer(markerData.marker);
            this.strikeMarkers.delete(strikeId);
        } else {
            // L'estil dels llamps en temps real continua basant-se en l'escala de 30 min
            this.updateMarkerStyle(markerData, ageMins);
        }
    });
},

updateMarkerStyle: function(markerData, ageMins = 0) {
    const color = this.getColorForAge(ageMins);
    
    // CORRECCIÓ: Hem esborrat una barra baixa extra de "MAX_AGE_MINS"
    const radius = 4 - (ageMins / this.MAX_AGE_MINS) * 2; 
    
    markerData.marker.setStyle({
        fillColor: color, 
        color: "#000000", 
        fillOpacity: 0.9, 
        opacity: 0.9,
        weight: 0.5, 
        radius: radius
    });
},
    
    getColorForAge: function(ageMins) {
        if (ageMins < 2) return '#FFFF00';
        if (ageMins < 5) return '#FFCC00';
        if (ageMins < 10) return '#FFA500';
        if (ageMins < 20) return '#FF4500';
        return '#B22222';
    },

    createExpandingCircle: function(lat, lon) {
        const circle = L.circle([lat, lon], { radius: 1, color: 'black', weight: 2, opacity: 0.8, fill: false, interactive: false, pane: 'markerPane' }).addTo(this.layerGroup);
        let currentRadius = 1;
        const animation = setInterval(() => {
            currentRadius += (currentRadius < 5000) ? 800 : 1000;
            const currentOpacity = 0.8 * (1 - (currentRadius / 45000));
            if (currentOpacity <= 0) {
                this.layerGroup.removeLayer(circle);
                clearInterval(animation);
            } else {
                circle.setRadius(currentRadius);
                circle.setStyle({ opacity: currentOpacity });
            }
        }, 20);
    },

    sendBoundsSubscription: function() {
        if (!this.isActive || !this.socketLm || this.socketLm.readyState !== 1) return;
        const bounds = map.getBounds();
        this.socketLm.send(JSON.stringify({ "v": 24, "a": 4, "i": {}, "p": [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()] }));
    },

    // Totes les funcions per a les dades històriques i resum
    toggleHistoricLayers: function(option) {
        this.currentMode = option;

        if (option !== 'historic') this.stopHistoricMode();
        if (this.layer1h && map.hasLayer(this.layer1h)) this.layer1h.removeFrom(map);
        if (this.layer24h && map.hasLayer(this.layer24h)) this.layer24h.removeFrom(map);

        switch (option) {
            case 'historic':
                this.startHistoricMode();
                break;
            case 'realtime_plus_1h':
                if (!this.layer1h) this.layer1h = L.tileLayer('https://tiles.lightningmaps.org/?x={x}&y={y}&z={z}&s=256&t=5', { maxZoom: 16, zIndex: 100, opacity: 0.7 });
                this.layer1h.addTo(map);
                break;
            case 'realtime_plus_24h':
                if (!this.layer24h) this.layer24h = L.tileLayer('https://tiles.lightningmaps.org/?x={x}&y={y}&z={z}&s=256&t=6', { maxZoom: 16, zIndex: 100, opacity: 0.7 });
                this.layer24h.addTo(map);
                break;
            case 'none':
                this.stopHistoricMode();
                break;
        }
    },

    startHistoricMode: function() {
        console.log("Iniciant mode històric de llamps.");
        this.fetchHistoricLightning();
        if (this.historicUpdateInterval) clearInterval(this.historicUpdateInterval);
        this.historicUpdateInterval = setInterval(() => this.fetchHistoricLightning(), 60000);
    },

    stopHistoricMode: function() {
        console.log("Aturant mode històric de llamps.");
        if (this.historicUpdateInterval) {
            clearInterval(this.historicUpdateInterval);
            this.historicUpdateInterval = null;
        }
        this.historicStrikes.clear();
        this.historicLayerGroup.clearLayers();
    },

fetchHistoricLightning: async function() {
    console.log("Actualitzant dades històriques de llamps (en mode UTC)...");
    const urls = [];
    for (let i = 0; i < 24; i++) {
        const folderName = String(i).padStart(2, '0');
        urls.push(`https://api.projecte4estacions.com/api/dades-historiques/${folderName}`);
    }
    try {
        const responses = await Promise.all(urls.map(url => fetch(url).then(res => res.json()).catch(() => [])));
        const allStrikes = responses.flat();
        const newHistoricStrikes = new Map();
        const now = new Date();
        const timeCutoff = now.getTime() - (120 * 60 * 1000);

        allStrikes.forEach(strike => {
            const strikeTime = new Date(strike[2] + 'Z').getTime();
            if (strikeTime >= timeCutoff) {
                const lat = strike[1];
                const lon = strike[0];
                const strikeId = `${lon}_${lat}_${strike[2]}`;
                newHistoricStrikes.set(strikeId, {
                    lat: lat,
                    lon: lon,
                    timestamp: strikeTime,
                });
            }
        });
        
        this.historicStrikes = newHistoricStrikes;
        console.log(`Processats ${this.historicStrikes.size} llamps històrics dins de la finestra de temps.`);
        this.updateHistoricMarkers();

        if (isAutoDetectMode) {
            analitzarTempestesSMC(); // Ja no necessita paràmetres, agafa les dades fusionades
        } else if (analisisPolygon) {
            analitzarLightningJump();
        }

    } catch (error) {
        console.error("Error obtenint dades històriques de llamps:", error);
    }
},

// Dins de l'objecte realtimeLightningManager
updateHistoricMarkers: function() {
    this.historicLayerGroup.clearLayers();
    const now = new Date().getTime();
    const timeFilterMs = this.timeFilterMinutes * 60 * 1000;
    this.historicStrikes.forEach(strike => {
        const ageMs = now - strike.timestamp;
        if (ageMs <= timeFilterMs) {
            const ageMins = ageMs / 60000;
            const color = this.getHistoricColorForAge(ageMins);
            const radius = 4 - (ageMins / 120) * 2.5; // Mida petita
            
            const marker = L.circleMarker([strike.lat, strike.lon], {
                radius: radius,
                fillColor: color,
                color: '#000000',
                weight: 0.5,
                opacity: 0.9,
                fillOpacity: 0.9,
                pane: 'llampsPane' // CORRECCIÓ: Especifiquem el 'pane' correcte aquí
            });
            this.historicLayerGroup.addLayer(marker);
        }
    });
},

    getHistoricColorForAge: function(ageMins) {
        if (ageMins < 5) return '#FFFFFF';
        if (ageMins < 15) return '#FFFF00';
        if (ageMins < 30) return '#FFCC00';
        if (ageMins < 60) return '#FFA500';
        if (ageMins < 90) return '#FF4500';
        return '#B22222';
    },

    setTimeFilter: function(minutes) {
        this.timeFilterMinutes = minutes;
        this.updateHistoricMarkers();
    }
};

// ======================================================
// PAS FINAL I CRUCIAL: ACTUALITZAR LA VISTA AL MOURE EL MAPA
// Afegeix aquest bloc al final de tot del teu fitxer.
// ======================================================
map.on('moveend zoomend', () => {
    // Si el mòdul de llamps està actiu, li diem que enviï les noves coordenades.
    if (realtimeLightningManager.isActive) {
        realtimeLightningManager.sendBoundsSubscription();
    }
});

// Fem una petita espera per assegurar que tot el mapa està carregat
setTimeout(() => {
    displayVariable('smc_32');

    // Marcar la primera opció del menú com a activa
    const defaultOption = document.querySelector('li[data-variable-key="smc_32"]');
    if(defaultOption) {
        defaultOption.classList.add('active');
        defaultOption.closest('.main-menu-item').querySelector('a').classList.add('active');
    }
}, 500);
