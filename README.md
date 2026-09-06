# FluidBurn

a modern fast alternative to lightburn!

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

First run walks you through your bed size and controller settings. After that
every job follows the same five steps, and the **Machine** panel on the right
tells you which one you're on.

1. **Connect** — pick the USB port your controller is on.
2. **Map the travel area** — jog the head to each of the four corners it can
   reach and record them. FluidBurn then refuses to drive past them. Optional,
   but it's the safety net; without it the edge guard falls back to the bed size
   in your machine profile. Corners are named from where you stand: **front** is
   the near side, **back** is the far side, and the top of the on-screen
   workspace is the back of the machine.
3. **Set job zero** — jog to the spot on your material where the design should
   start. That point becomes X0 Y0 for the job.
4. **Import and generate** — load an SVG, DXF or image, place it, set power and
   speed per layer, then **Generate G-code**. **Save G-code…** writes it to a
   file instead.
5. **Frame, then Run** — framing traces the outline with the beam off so you can
   check placement before committing.

### Two different "origins"

They're easy to mix up, so FluidBurn keeps them separate:

- **X0 Y0 corner** (machine profile) — a fact about your hardware: which corner
  of the bed your controller counts from. You set it once.
- **Job zero** (Machine panel) — where *this* job starts on *this* piece of
  material. You set it every time you load new stock.


## ⚠️ Laser safety

Wear the right goggles. Use an enclosure and fume extraction. Never leave it running. Have a hardware E-stop.

## Build a release

```bash
npm run tauri build
```
