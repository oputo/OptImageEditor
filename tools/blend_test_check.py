# Per-cell comparison of the layer composite with Photoshop's composite for tools/ps_blend_test.jsx output.
import asyncio, json, sys
from playwright.async_api import async_playwright
NAMES = ["normal","dissolve","darken","multiply","color burn","linear burn","darker color","lighten","screen","color dodge",
 "linear dodge","lighter color","overlay","soft light","hard light","vivid light","linear light","pin light","hard mix",
 "difference","exclusion","subtract","divide","hue","saturation","color","luminosity",
 "multiply op50","colorburn fill50","lineardodge fill50","hardmix fill50","group pass 60 (multiply)","group normal (screen)",
 "clip base + multiply","mask 255/192/96/0","overlay op70 fill40"]
async def main():
    f = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"])
        pg = await b.new_page(viewport={"width":1200,"height":800})
        await pg.goto("http://localhost:4173/")
        await pg.evaluate("""async (f)=>{const blob=await (await fetch('/samples/'+f)).blob();await window.__oie.openFile(new File([blob],f));}""", f)
        await pg.wait_for_timeout(300)
        r = await pg.evaluate("""async ()=>{const vs=window.__oie.vs, t=vs.active; await vs.loadLayers(t);
          const r=vs.renderer, doc=vs.docs.get(t.id); r.show(doc.output);
          const a=r.readSet(doc.output); const e=vs.cache.get(t.key); const bb=r.readSet(e.set); const W=doc.data.width;
          const cells=[]; for(let c=0;c<36;c++){ const cx=(c%9)*128, cy=Math.floor(c/9)*128; let max=0,sum=0,n=0,worst=null;
            for(let y=cy;y<cy+128;y++) for(let x=cx;x<cx+128;x++){ const i=(y*W+x)*4; let m=0; for(let k=0;k<4;k++){const d=Math.abs(a[i+k]-bb[i+k]); sum+=d; if(d>m)m=d;} n++;
              if(m>max){max=m; worst={x:x-cx,y:y-cy,ours:Array.from(a.slice(i,i+4)),ps:Array.from(bb.slice(i,i+4))};} }
            cells.push({max, mean: sum/(n*4), worst}); } return cells; }""")
        for i, c in enumerate(r):
            print(f"{i:2d} {NAMES[i]:28s} max {c['max']:3d} mean {c['mean']:.3f}  worst {c['worst']}")
        await b.close()
asyncio.run(main())
