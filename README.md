# FluidBurn

A laser cutter app. Open a file, lay it out, send it to the machine.

For a DIY laser: **Arduino + CNC shield running GRBL**, TMC2209 drivers, a diode laser.

## Download (macOS)

Grab the latest **`.dmg`** from the [Releases page](https://github.com/aaravjhamb/fluidburn/releases/latest). It's a universal build — works on both Apple Silicon and Intel Macs.

This build isn't signed by Apple yet, so the first launch needs one extra step. After dragging FluidBurn to Applications, open **Terminal** and run:

```bash
xattr -cr /Applications/FluidBurn.app
```

Then open it normally. (One time only. Alternatively: right-click the app → **Open**, then **Privacy & Security → Open Anyway** if macOS still blocks it.)

## Run it

```bash
npm install
npm run tauri dev
```

## Use it

1. **Import…** an SVG, DXF, or image.
2. Drag, resize, rotate it. Set power/speed per layer on the left.
3. **Generate G-code**, then **Save G-code…** for a file, or **Run** to send it to the machine.

Connect: plug in the Arduino (or pair an HC-05), pick the port, hit Connect.

## ⚠️ Laser safety

Wear the right goggles. Use an enclosure and fume extraction. Never leave it running. Have a hardware E-stop.

## Build a release

```bash
npm run tauri build
```
