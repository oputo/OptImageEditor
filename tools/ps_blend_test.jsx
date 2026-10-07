// OptImageEditor: blend mode test document for Photoshop (ExtendScript).
// Run in Photoshop: File > Scripts > Browse... and pick this file. Takes about 1-3 minutes.
//
// Makes a 1152 x 512 px RGB document of 128 px cells (9 x 4) and saves it as a PSD with
// "Maximize Compatibility" on, so the file contains Photoshop's own composite. OptImageEditor's
// compositor is checked against that composite cell by cell (layout is fixed, see CELLS below).
//
// Every cell: a backdrop of 16 vertical colour stripes (8 px) and a test layer of 16 horizontal colour
// stripes; the left half of the test layer is opaque, the right half has 50 % pixel alpha.
#target photoshop

var CELL = 128;
var COLS = 9;
var BACK = [[0,0,0],[255,255,255],[128,128,128],[64,64,64],[192,192,192],[255,0,0],[0,255,0],[0,0,255],
            [255,128,0],[40,90,200],[200,40,120],[30,160,90],[250,230,60],[120,60,20],[180,200,220],[16,16,16]];
var SRC = [[0,0,0],[255,255,255],[128,128,128],[32,32,32],[224,224,224],[255,0,0],[0,200,255],[90,40,180],
           [255,200,150],[60,120,60],[230,60,60],[20,20,120],[200,255,100],[100,100,30],[170,120,220],[250,250,10]];

// cell index -> test; keep in sync with tools/blend_test_layout.json
var MODES = ["NORMAL","DISSOLVE","DARKEN","MULTIPLY","COLORBURN","LINEARBURN","DARKERCOLOR",
             "LIGHTEN","SCREEN","COLORDODGE","LINEARDODGE","LIGHTERCOLOR",
             "OVERLAY","SOFTLIGHT","HARDLIGHT","VIVIDLIGHT","LINEARLIGHT","PINLIGHT","HARDMIX",
             "DIFFERENCE","EXCLUSION","SUBTRACT","DIVIDE","HUE","SATURATION","COLORBLEND","LUMINOSITY"];

function cTID(s) { return charIDToTypeID(s); }

function cellXY(i) { return [(i % COLS) * CELL, Math.floor(i / COLS) * CELL]; }

function color(rgb) {
  var c = new SolidColor();
  c.rgb.red = rgb[0]; c.rgb.green = rgb[1]; c.rgb.blue = rgb[2];
  return c;
}

function fillRect(doc, x, y, w, h, rgb, opacity) {
  doc.selection.select([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
  doc.selection.fill(color(rgb), ColorBlendMode.NORMAL, opacity, false);
}

/** the 16 horizontal stripes of a test layer in cell i (left half opaque, right half 50 %) */
function stripes(doc, i) {
  var p = cellXY(i);
  for (var k = 0; k < 16; k++) {
    fillRect(doc, p[0], p[1] + k * 8, CELL / 2, 8, SRC[k], 100);
    fillRect(doc, p[0] + CELL / 2, p[1] + k * 8, CELL / 2, 8, SRC[k], 50);
  }
}

function newLayer(doc, name, parent) {
  var l = (parent || doc).artLayers.add();
  l.name = name;
  doc.activeLayer = l;
  return l;
}

/** adds a "reveal all" layer mask to the active layer and leaves the mask targeted for painting */
function addMask() {
  var d = new ActionDescriptor();
  d.putClass(cTID("Nw  "), cTID("Chnl"));
  var r = new ActionReference();
  r.putEnumerated(cTID("Chnl"), cTID("Chnl"), cTID("Msk "));
  d.putReference(cTID("At  "), r);
  d.putEnumerated(cTID("Usng"), cTID("UsrM"), cTID("RvlA"));
  executeAction(cTID("Mk  "), d, DialogModes.NO);
}

/** targets the layer pixels (RGB) again after painting a mask */
function selectRGB() {
  var d = new ActionDescriptor();
  var r = new ActionReference();
  r.putEnumerated(cTID("Chnl"), cTID("Chnl"), cTID("RGB "));
  d.putReference(cTID("null"), r);
  executeAction(cTID("slct"), d, DialogModes.NO);
}

function main() {
  var oldUnits = app.preferences.rulerUnits;
  var oldCompat = app.preferences.maximizeCompatibility;
  app.preferences.rulerUnits = Units.PIXELS;
  var doc = app.documents.add(COLS * CELL, 4 * CELL, 72, "oie_blend_test", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
  try {
    // backdrop: vertical stripes over the whole document
    var back = doc.activeLayer;
    back.name = "backdrop";
    for (var x = 0; x < COLS * CELL; x += 8) fillRect(doc, x, 0, 8, 4 * CELL, BACK[(x / 8) % 16], 100);

    // 0..26: one blend mode per cell
    for (var i = 0; i < MODES.length; i++) {
      var l = newLayer(doc, "mode " + MODES[i]);
      stripes(doc, i);
      l.blendMode = BlendMode[MODES[i]];
    }
    // 27: multiply at 50 % opacity
    var a = newLayer(doc, "multiply op50"); stripes(doc, 27); a.blendMode = BlendMode.MULTIPLY; a.opacity = 50;
    // 28 / 29 / 30: fill 50 % on modes where Photoshop treats fill differently from opacity
    var b = newLayer(doc, "colorburn fill50"); stripes(doc, 28); b.blendMode = BlendMode.COLORBURN; b.fillOpacity = 50;
    var c = newLayer(doc, "lineardodge fill50"); stripes(doc, 29); c.blendMode = BlendMode.LINEARDODGE; c.fillOpacity = 50;
    var e = newLayer(doc, "hardmix fill50"); stripes(doc, 30); e.blendMode = BlendMode.HARDMIX; e.fillOpacity = 50;

    // 31: pass-through group at 60 % with a multiply layer inside
    var g1 = doc.layerSets.add(); g1.name = "group pass 60";
    var g1l = newLayer(doc, "in pass multiply", g1); stripes(doc, 31); g1l.blendMode = BlendMode.MULTIPLY;
    g1.blendMode = BlendMode.PASSTHROUGH; g1.opacity = 60;

    // 32: isolated (normal) group with a screen layer inside
    var g2 = doc.layerSets.add(); g2.name = "group normal";
    var g2l = newLayer(doc, "in normal screen", g2); stripes(doc, 32); g2l.blendMode = BlendMode.SCREEN;
    g2.blendMode = BlendMode.NORMAL;

    // 33: clipping mask: base layer = cell with 3 alpha bands, clipped multiply layer
    var p33 = cellXY(33);
    var base = newLayer(doc, "clip base");
    fillRect(doc, p33[0], p33[1], CELL, 40, [255, 255, 255], 100);
    fillRect(doc, p33[0], p33[1] + 40, CELL, 40, [200, 120, 40], 50);
    var clip = newLayer(doc, "clipped multiply"); stripes(doc, 33); clip.blendMode = BlendMode.MULTIPLY; clip.grouped = true;

    // 34: layer mask with 4 grey bands (255 / 192 / 96 / 0)
    var m = newLayer(doc, "masked normal"); stripes(doc, 34);
    addMask();
    var p34 = cellXY(34);
    var greys = [255, 192, 96, 0];
    for (var k = 0; k < 4; k++) fillRect(doc, p34[0] + k * 32, p34[1], 32, CELL, [greys[k], greys[k], greys[k]], 100);
    selectRGB();

    // 35: overlay at 70 % opacity and 40 % fill
    var o = newLayer(doc, "overlay op70 fill40"); stripes(doc, 35); o.blendMode = BlendMode.OVERLAY; o.opacity = 70; o.fillOpacity = 40;

    doc.selection.deselect();
    var f = File.saveDialog("テスト用 PSD の保存先", "Photoshop:*.psd");
    if (!f) { alert("保存を取り消しました（ドキュメントは開いたままです）"); return; }
    if (!/\.psd$/i.test(f.name)) f = new File(f.fsName + ".psd");
    app.preferences.maximizeCompatibility = QueryStateType.ALWAYS;
    var opts = new PhotoshopSaveOptions();
    opts.layers = true;
    doc.saveAs(f, opts, true, Extension.LOWERCASE);
    alert("保存しました: " + f.fsName);
  } finally {
    app.preferences.rulerUnits = oldUnits;
    app.preferences.maximizeCompatibility = oldCompat;
  }
}

main();
