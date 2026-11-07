// The plate in 3D: the printable area, its no-go zones, and every copy where the packer put it. One instanced
// mesh per part, so a plate of hundreds of copies is a handful of draw calls. Renders on demand, not in a loop.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BedSpec, Layout, Part } from '../types.ts';

export const PART_COLOURS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

interface Props {
  bed: BedSpec | null;
  parts: Part[];
  layout: Layout | null;
  caption?: string;
}

type View = 'angle' | 'top';

interface Ctx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  bedGroup: THREE.Group;
  partGroup: THREE.Group;
  render: () => void;
}

function shapeOf(poly: [number, number][]): THREE.Shape {
  const s = new THREE.Shape();
  poly.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  return s;
}

export function BedView({ bed, parts, layout, caption }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef<Ctx | null>(null);
  const [view, setView] = useState<View>('angle');
  const [failed, setFailed] = useState(false);

  // Scene, renderer and controls, once.
  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0d1b2a);
    el.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdde8f5, 0x1b3350, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-0.6, -1, 1.6);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 10000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    const bedGroup = new THREE.Group();
    const partGroup = new THREE.Group();
    scene.add(bedGroup, partGroup);
    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);
    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    ctx.current = { renderer, scene, camera, controls, bedGroup, partGroup, render };
    resize();
    return () => {
      ro.disconnect();
      controls.dispose();
      const dispose = (o: THREE.Object3D) =>
        o.traverse((n) => {
          const m = n as THREE.Mesh;
          m.geometry?.dispose();
          const mat = m.material as THREE.Material | THREE.Material[] | undefined;
          (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
        });
      dispose(scene);
      renderer.dispose();
      renderer.domElement.remove();
      ctx.current = null;
    };
  }, []);

  // The bed.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    clear(c.bedGroup);
    if (!bed) return c.render();
    const [x0, y0] = bed.min;
    const [x1, y1] = bed.max;
    const area = bed.regions[0];
    const plate = new THREE.Mesh(new THREE.ShapeGeometry(shapeOf(area)), new THREE.MeshBasicMaterial({ color: 0x1b3350 }));
    plate.position.z = -0.05;
    c.bedGroup.add(plate);
    // 10 mm grid, 50 mm lines brighter.
    const minor: number[] = [];
    const major: number[] = [];
    for (let x = Math.ceil(x0 / 10) * 10; x <= x1; x += 10) (x % 50 === 0 ? major : minor).push(x, y0, 0, x, y1, 0);
    for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) (y % 50 === 0 ? major : minor).push(x0, y, 0, x1, y, 0);
    const lines = (pts: number[], color: number, opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    };
    c.bedGroup.add(lines(minor, 0x2a466a, 0.55), lines(major, 0x2a466a, 1));
    const outline = (poly: [number, number][], color: number, z: number) => {
      const pts = poly.flatMap(([x, y]) => [x, y, z]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([...pts, pts[0], pts[1], pts[2]], 3));
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
    };
    c.bedGroup.add(outline(area, 0x6f8298, 0.02));
    // Each nozzle's reach on a multi-nozzle printer.
    for (const r of bed.regions.slice(1)) c.bedGroup.add(outline(r, 0xa8b7c7, 0.03));
    for (const ex of bed.exclusions) {
      const m = new THREE.Mesh(
        new THREE.ShapeGeometry(shapeOf(ex)),
        new THREE.MeshBasicMaterial({ color: 0xd03b3b, transparent: true, opacity: 0.35, depthWrite: false }),
      );
      m.position.z = 0.01;
      c.bedGroup.add(m, outline(ex, 0xd03b3b, 0.04));
    }
    frame(c, bed, view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bed]);

  useEffect(() => {
    const c = ctx.current;
    if (c && bed) frame(c, bed, view);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  // The parts.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    clear(c.partGroup);
    if (layout) {
      const m = new THREE.Matrix4();
      const t = new THREE.Matrix4();
      parts.forEach((part, i) => {
        const placements = layout.placements.filter((p) => p.partId === part.id);
        if (!placements.length) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
        g.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({ color: PART_COLOURS[i % PART_COLOURS.length], roughness: 0.7, metalness: 0, flatShading: true });
        const inst = new THREE.InstancedMesh(g, mat, placements.length);
        placements.forEach((p, k) => {
          m.makeRotationZ((p.angle * Math.PI) / 180);
          t.makeTranslation(p.x, p.y, 0);
          inst.setMatrixAt(k, t.multiply(m));
        });
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
        c.partGroup.add(inst);
      });
    }
    c.render();
  }, [parts, layout]);

  return (
    <div className="bed" ref={host}>
      {failed && <div className="empty">This browser could not start WebGL, so the 3D view is off. Everything else works.</div>}
      <div className="views">
        <button type="button" aria-pressed={view === 'angle'} onClick={() => setView('angle')}>
          3D
        </button>
        <button type="button" aria-pressed={view === 'top'} onClick={() => setView('top')}>
          Top
        </button>
      </div>
      {caption && <div className="overlay">{caption}</div>}
    </div>
  );
}

function clear(g: THREE.Group) {
  for (const child of [...g.children]) {
    g.remove(child);
    child.traverse((n) => {
      const m = n as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
    });
  }
}

function frame({ camera, controls, render }: Ctx, bed: BedSpec, view: View) {
  const cx = (bed.min[0] + bed.max[0]) / 2;
  const cy = (bed.min[1] + bed.max[1]) / 2;
  const size = Math.max(bed.max[0] - bed.min[0], bed.max[1] - bed.min[1]);
  const dist = (size / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.15;
  controls.target.set(cx, cy, 0);
  if (view === 'top') camera.position.set(cx, cy - 0.001, dist);
  else camera.position.set(cx, cy - dist * 0.78, dist * 0.72);
  camera.near = dist / 100;
  camera.far = dist * 10;
  camera.updateProjectionMatrix();
  controls.update();
  render();
}
