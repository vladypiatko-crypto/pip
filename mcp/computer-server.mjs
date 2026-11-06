// MCP server that gives Claude Code eyes and hands on this computer.
// Claude Code starts it (see the mcp config Pip writes). Every tool call is
// forwarded to the running Pip app over localhost with a secret token; the app
// takes the screenshot or moves the mouse, so the pet can show what it's doing
// and stop instantly if you press Stop.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const URL = process.env.PIP_CONTROL_URL;
const TOKEN = process.env.PIP_CONTROL_TOKEN;

async function call(name, args) {
  try {
    const res = await fetch(`${URL}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name, args }),
    });
    const out = await res.json();
    if (!res.ok) return { isError: true, content: [{ type: 'text', text: out.error || `Pip refused (${res.status})` }] };
    return out;
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Could not reach Pip: ${err.message}` }] };
  }
}

const server = new McpServer({ name: 'pip-computer', version: '1.0.0' });
const xy = { x: z.number().describe('X in screenshot pixels'), y: z.number().describe('Y in screenshot pixels') };

const tools = [
  ['screenshot', 'Take a screenshot of the main screen. Always do this first, and again after actions, to see the result. Coordinates for other tools use this screenshot\'s pixels.', {}],
  ['click', 'Click at a point on the screen.', { ...xy, button: z.enum(['left', 'right', 'middle']).optional(), double: z.boolean().optional().describe('Double-click') }],
  ['move_mouse', 'Move the mouse pointer to a point without clicking.', xy],
  ['drag', 'Press the left button at one point, drag to another, release.', { from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number() }],
  ['type_text', 'Type text with the keyboard into whatever has focus.', { text: z.string() }],
  ['press_keys', 'Press a key or shortcut, e.g. "enter", "ctrl+s", "cmd+space", "alt+tab", "down".', { keys: z.string() }],
  ['scroll', 'Scroll the mouse wheel at a point.', { ...xy, direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().optional().describe('Wheel steps, default 5') }],
  ['wait', 'Wait for something to load.', { seconds: z.number().max(30) }],
  ['open', 'Open a URL in the default browser, or a file/folder/app path with its default program.', { target: z.string() }],
];

// ---- Skin designer: Pip can create its own outfits ----
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Color like "#ff8800"');
const finish = z.object({
  color: hex,
  metalness: z.number().min(0).max(1).optional(),
  roughness: z.number().min(0).max(1).optional(),
  emissive: hex.optional().describe('Glow color'),
  emissiveIntensity: z.number().min(0).max(5).optional(),
});
const vec3 = z.array(z.number()).length(3);
const SKIN_GUIDE = `Pip's body is a ball about 2 units wide centered at [0,0,0]. Y is up, +Z faces the viewer, +X is Pip's left side on screen-right.
Landmarks: top of head [0,1,0]; eyes at [±0.34,0.2,0.86]; mouth [0,-0.04,0.93]; cheeks [±0.55,-0.02,0.79]; belly patch [0,-0.25,0.66]; hands at [±1.22,-0.45,0.15] (radius 0.2).
Color slots: body, belly, eye, highlight (eye sparkle), cheek, bulb (antenna light), accent (stem, leaf, crown, headphones, beanie).
Built-in accessories you can switch on with "parts": stem, bulb, leaf, crown, headphones, beanie.
"extras" are new accessories built from shapes. Every shape is unit-sized (sphere/cylinder/cone diameter 1 and height 1, box 1x1x1, torus ring diameter 1) and you size it with "scale" [x,y,z].
attach "body" (default) positions are relative to Pip's center; attach "hand_L"/"hand_R" positions are relative to that hand, so the item moves with it. rotation is in radians [x,y,z].
Tips: a hat brim is a thin cylinder (scale [1.4,0.08,1.4]) at y≈0.95; horns are cones tilted outward; an eyepatch is a flattened sphere over one eye at z≈0.95; a sword is a long thin box attached to a hand. Up to 40 extras.`;

const skinTools = [
  ['save_skin', 'Create or update one of Pip\'s skins (outfit) and wear it. Use when the user asks for a new look, e.g. "make yourself a pirate skin". ' + SKIN_GUIDE, {
    id: z.string().regex(/^[a-z0-9-]{2,30}$/).describe('Short id, e.g. "pirate"'),
    label: z.string().min(1).max(30).describe('Display name, e.g. "Pirate"'),
    colors: z.object({ body: finish, belly: finish, eye: finish, highlight: finish, cheek: finish, bulb: finish, accent: finish }).partial(),
    parts: z.array(z.enum(['stem', 'bulb', 'leaf', 'crown', 'headphones', 'beanie'])).describe('Built-in accessories to show (can be empty)'),
    extras: z.array(z.object({
      shape: z.enum(['sphere', 'box', 'cylinder', 'cone', 'torus', 'capsule']),
      attach: z.enum(['body', 'hand_L', 'hand_R']).optional(),
      position: vec3,
      rotation: vec3.optional(),
      scale: vec3.optional(),
      tube: z.number().min(0.02).max(0.45).optional().describe('Torus thickness, default 0.12'),
      color: hex,
      metalness: z.number().min(0).max(1).optional(),
      roughness: z.number().min(0).max(1).optional(),
      emissive: hex.optional(),
      emissiveIntensity: z.number().min(0).max(5).optional(),
    })).max(40).optional(),
    wear: z.boolean().optional().describe('Wear it now (default true)'),
  }],
  ['list_skins', 'List Pip\'s skins (built-in and custom) and which one it is wearing.', {}],
  ['wear_skin', 'Switch Pip to one of its existing skins.', { id: z.string() }],
  ['delete_skin', 'Delete one of the custom skins Pip made (built-in skins can\'t be deleted).', { id: z.string() }],
];

const toolset = process.env.PIP_TOOLSET === 'skins' ? skinTools : [...tools, ...skinTools];
for (const [name, description, shape] of toolset) {
  server.registerTool(name, { description, inputSchema: shape }, (args) => call(name, args));
}

await server.connect(new StdioServerTransport());
