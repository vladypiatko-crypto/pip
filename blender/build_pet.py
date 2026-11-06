"""
Builds "Pip", the desktop pet, in Blender.

  - Models the body, face, hands and every optional accessory (stem, bulb, leaf,
    crown, headphones, beanie) from primitives.
  - Exports assets/pip.glb (all parts, materials named mat_<slot>) for the app.
  - Renders assets/previews/<skin>.png for every skin in assets/skins.json.

Run with Blender:      blender -b -P blender/build_pet.py
or the bpy module:     pip install bpy && python blender/build_pet.py
Add  --no-render  to only export the model.
"""
import json
import math
import os
import sys

import bpy  # must come first when running as the bpy module
import bmesh

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "assets")
SKINS = json.load(open(os.path.join(ASSETS, "skins.json")))
SLOTS = ["body", "belly", "eye", "highlight", "cheek", "bulb", "accent"]
RENDER = "--no-render" not in sys.argv


# ---------------------------------------------------------------- helpers

def hex_to_linear(h):
    h = h.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, 1.0)


MATS = {}


def material(slot):
    m = bpy.data.materials.new("mat_" + slot)
    try:
        m.use_nodes = True  # deprecated (always on) in Blender 5, needed in 4.x
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None) or nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    MATS[slot] = (m, bsdf)
    return m


def set_input(bsdf, names, value):
    for n in names:
        if n in bsdf.inputs:
            bsdf.inputs[n].default_value = value
            return


def apply_skin(name):
    skin = SKINS["skins"][name]
    for slot in SLOTS:
        m, bsdf = MATS[slot]
        s = skin[slot]
        set_input(bsdf, ["Base Color"], hex_to_linear(s["color"]))
        set_input(bsdf, ["Metallic"], s.get("metalness", 0.0))
        set_input(bsdf, ["Roughness"], s.get("roughness", 0.5))
        set_input(bsdf, ["Emission Color", "Emission"], hex_to_linear(s.get("emissive", "#000000")))
        set_input(bsdf, ["Emission Strength"], s.get("emissiveIntensity", 0.0) if "emissive" in s else 0.0)
        set_input(bsdf, ["Coat Weight"], 0.25 if slot in ("body", "eye") else 0.0)
        m.diffuse_color = hex_to_linear(s["color"])
    for ob in bpy.data.objects:
        part = ob.get("part")
        if part:
            visible = part in skin["parts"]
            ob.hide_render = not visible
            ob.hide_viewport = False  # keep everything exportable


def finish(ob, slot, part=None, smooth=True):
    ob.data.materials.append(MATS[slot][0])
    if part:
        ob["part"] = part
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if smooth:
        bpy.ops.object.shade_smooth()
    return ob


def sphere(name, r, loc, scale=(1, 1, 1), seg=48, rings=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, radius=r, location=loc)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = scale
    return ob


def cylinder(name, r, depth, loc, rot=(0, 0, 0), fill="NGON", verts=48):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot, end_fill_type=fill)
    ob = bpy.context.active_object
    ob.name = name
    return ob


def half_torus(name, major, minor, loc, keep_positive_y, scale=(1, 1, 1)):
    """A torus cut in half, then stood up to face the camera (front is -Y)."""
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=64, minor_segments=16, location=(0, 0, 0))
    ob = bpy.context.active_object
    ob.name = name
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    doomed = [v for v in bm.verts if (v.co.y < -1e-4 if keep_positive_y else v.co.y > 1e-4)]
    bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()
    ob.rotation_euler = (math.pi / 2, 0, 0)  # +Y half becomes the top half
    ob.location = loc
    ob.scale = scale
    return ob


def subdivide(ob, levels=2):
    mod = ob.modifiers.new("Subdivision", "SUBSURF")
    mod.levels = levels
    mod.render_levels = levels


# ---------------------------------------------------------------- model

def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for slot in SLOTS:
        material(slot)

    # Body: a soft bean, a little wider than tall, front faces -Y.
    finish(sphere("body", 1.0, (0, 0, 0), (1.05, 0.95, 1.0), 64, 32), "body")
    finish(sphere("belly", 0.62, (0, -0.66, -0.25), (1.0, 0.42, 0.95)), "belly")

    # Face
    for side, x in (("L", -0.34), ("R", 0.34)):
        finish(sphere(f"eye_{side}", 0.17, (x, -0.855, 0.2), (0.85, 0.5, 1.15)), "eye")
        finish(sphere(f"highlight_{side}", 0.05, (x + 0.05, -0.93, 0.29), (1, 0.6, 1), 24, 12), "highlight")
        finish(sphere(f"cheek_{side}", 0.13, (x * 1.62, -0.79, -0.02), (1.0, 0.32, 0.68), 32, 16), "cheek")
    finish(half_torus("mouth", 0.09, 0.022, (0, -0.935, -0.04), keep_positive_y=False), "eye")

    # Little floating hands
    for side, x in (("L", -1.22), ("R", 1.22)):
        finish(sphere(f"hand_{side}", 0.2, (x, -0.15, -0.45), (0.8, 0.75, 1.0), 32, 16), "body")

    # Optional: antenna stem with a glowing bulb, or a sprout
    stem = cylinder("stem", 0.045, 0.42, (0.0, 0, 1.15), rot=(0, 0.15, 0), verts=24)
    finish(stem, "accent", "stem")
    finish(sphere("bulb", 0.13, (0.05, 0, 1.42), seg=32, rings=16), "bulb", "bulb")
    leaf1 = sphere("leaf_big", 0.26, (0.2, 0, 1.38), (1.0, 0.24, 0.42), 32, 16)
    leaf1.rotation_euler = (0, -0.5, 0)
    finish(leaf1, "accent", "leaf")
    leaf2 = sphere("leaf_small", 0.19, (-0.13, 0, 1.35), (1.0, 0.24, 0.42), 32, 16)
    leaf2.rotation_euler = (0, 0.6, 0)
    finish(leaf2, "accent", "leaf")

    # Optional: crown
    finish(cylinder("crown_band", 0.48, 0.18, (0, 0, 0.9), fill="NOTHING"), "accent", "crown")
    for i in range(5):
        a = i / 5 * math.tau + math.pi / 2
        bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=0.12, radius2=0.0, depth=0.32, location=(math.cos(a) * 0.45, math.sin(a) * 0.45, 1.14))
        cone = bpy.context.active_object
        cone.name = f"crown_spike_{i}"
        finish(cone, "accent", "crown", smooth=False)
        finish(sphere(f"crown_gem_{i}", 0.055, (math.cos(a) * 0.45, math.sin(a) * 0.45, 1.31), seg=16, rings=8), "cheek", "crown")

    # Optional: headphones
    finish(half_torus("headphones_band", 1.1, 0.06, (0, 0, 0.1), keep_positive_y=True), "accent", "headphones")
    for side, x in (("L", -1.07), ("R", 1.07)):
        cup = cylinder(f"headphones_cup_{side}", 0.26, 0.18, (x, 0, 0.1), rot=(0, math.pi / 2, 0))
        subdivide(cup, 1)
        finish(cup, "accent", "headphones")
        finish(cylinder(f"headphones_glow_{side}", 0.15, 0.02, (x * 1.085, 0, 0.1), rot=(0, math.pi / 2, 0), verts=32), "bulb", "headphones")

    # Optional: knitted beanie with a pom-pom
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=1.0, location=(0, 0, 0))
    hat = bpy.context.active_object
    hat.name = "beanie_hat"
    bm = bmesh.new()
    bm.from_mesh(hat.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < 0.45], context="VERTS")
    bm.to_mesh(hat.data)
    bm.free()
    hat.scale = (1.1, 1.0, 1.06)
    finish(hat, "accent", "beanie")
    bpy.ops.mesh.primitive_torus_add(major_radius=0.98, minor_radius=0.11, major_segments=64, minor_segments=16, location=(0, 0, 0.48))
    brim = bpy.context.active_object
    brim.name = "beanie_brim"
    brim.scale = (1.0, 0.91, 1.0)
    finish(brim, "accent", "beanie")
    finish(sphere("beanie_pom", 0.18, (0, 0, 1.17), seg=32, rings=16), "belly", "beanie")


# ---------------------------------------------------------------- render setup

def stage():
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (1.4, -5.8, 1.1)
    target = bpy.data.objects.new("target", None)
    target.location = (0, 0, 0.35)
    scene.collection.objects.link(target)
    c = cam.constraints.new("TRACK_TO")
    c.target = target
    c.track_axis = "TRACK_NEGATIVE_Z"
    c.up_axis = "UP_Y"
    scene.camera = cam

    def light(name, kind, loc, energy, size, color=(1, 1, 1)):
        d = bpy.data.lights.new(name, kind)
        d.energy = energy
        d.color = color
        if kind == "AREA":
            d.size = size
        ob = bpy.data.objects.new(name, d)
        ob.location = loc
        tc = ob.constraints.new("TRACK_TO")
        tc.target = target
        tc.track_axis = "TRACK_NEGATIVE_Z"
        tc.up_axis = "UP_Y"
        scene.collection.objects.link(ob)

    light("key", "AREA", (-3, -4, 4), 900, 4, (1.0, 0.96, 0.9))
    light("fill", "AREA", (4, -3, 1), 300, 4, (0.85, 0.9, 1.0))
    light("rim", "AREA", (0, 4, 3), 700, 3)

    world = bpy.data.worlds.new("world")
    scene.world = world
    try:
        world.use_nodes = True
    except Exception:
        pass
    bg = next((n for n in world.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg:
        bg.inputs["Color"].default_value = (0.5, 0.5, 0.55, 1)
        bg.inputs["Strength"].default_value = 0.6

    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    try:
        scene.view_settings.view_transform = "Standard"
    except Exception:
        pass


def main():
    build()
    apply_skin(SKINS["default"])
    glb = os.path.join(ASSETS, "pip.glb")
    bpy.ops.export_scene.gltf(
        filepath=glb, export_format="GLB", export_apply=True, export_yup=True,
        export_extras=True, export_cameras=False, export_lights=False,
    )
    print("exported", glb)
    if not RENDER:
        return
    stage()
    os.makedirs(os.path.join(ASSETS, "previews"), exist_ok=True)
    for name in SKINS["skins"]:
        apply_skin(name)
        bpy.context.scene.render.filepath = os.path.join(ASSETS, "previews", f"{name}.png")
        bpy.ops.render.render(write_still=True)
        print("rendered", name)


main()
