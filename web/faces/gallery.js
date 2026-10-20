// A page to look at faces while working on them: every skin with every kind of eyes, every shape, each state, a crowd of bots,
// and big ones. Open /faces/gallery.html on a running server.

import htm from "htm";
import { h, render } from "preact";
import { useState } from "preact/hooks";
import { Face } from "./face.js";
import { DEFAULT_COLORS, EYES, SHAPES, SKINS, STATES } from "./params.js";
import { supported } from "./renderer.js";

const html = htm.bind(h);
const NAMES = ["Noid", "Researcher", "Writer", "Scout", "Ledger", "Coder", "Courier", "Sentinel"];

function Gallery() {
    const [state, setState] = useState("idle");
    const [color, setColor] = useState("#7aa2f7");
    const [size, setSize] = useState(64);

    return html`
        <h1>noid faces</h1>
        <p>Renderer: ${supported() ? "WebGL2 (shared context)" : "SVG fallback"}. Move the pointer near a face; click one.</p>
        <div class="controls">
            ${STATES.map(
                (each) => html`
                    <button aria-pressed=${String(each === state)} onClick=${() => setState(each)}>
                        ${each}
                    </button>
                `,
            )}
            <label>color <input type="color" value=${color} onInput=${(event) => setColor(event.target.value)} /></label>
            <label>
                size
                <input
                    type="range"
                    min="20"
                    max="128"
                    value=${size}
                    onInput=${(event) => setSize(Number(event.target.value))}
                />
                ${size}px
            </label>
        </div>

        <h2>Skins × eyes</h2>
        <div class="grid">
            <span></span>
            ${SKINS.map((skin) => html`<strong class="cell">${skin}</strong>`)}
            ${EYES.map(
                (eyes) => html`
                    <strong class="cell">${eyes}</strong>
                    ${SKINS.map(
                        (skin) => html`
                            <div class="cell">
                                <${Face}
                                    id=${`${skin}-${eyes}`}
                                    color=${color}
                                    skin=${skin}
                                    eyes=${eyes}
                                    state=${state}
                                    size=${size}
                                    label=${`${skin} ${eyes}`}
                                />
                            </div>
                        `,
                    )}
                `,
            )}
        </div>

        <h2>Shapes × skins</h2>
        <div class="grid">
            <span></span>
            ${SKINS.map((skin) => html`<strong class="cell">${skin}</strong>`)}
            ${SHAPES.map(
                (shape, row) => html`
                    <strong class="cell">${shape}</strong>
                    ${SKINS.map(
                        (skin, column) => html`
                            <div class="cell">
                                <${Face}
                                    id=${`${shape}-${skin}`}
                                    color=${DEFAULT_COLORS[(row + column) % DEFAULT_COLORS.length]}
                                    skin=${skin}
                                    eyes=${EYES[(row + column) % EYES.length]}
                                    shape=${shape}
                                    state=${state}
                                    size=${size}
                                    label=${`${shape} ${skin}`}
                                />
                            </div>
                        `,
                    )}
                `,
            )}
        </div>

        <h2>Every state</h2>
        <div class="hero">
            ${STATES.map(
                (each) => html`
                    <div class="cell">
                        <${Face} id="Noid" color=${color} state=${each} size=${96} label=${`Noid ${each}`} />
                        ${each}
                    </div>
                `,
            )}
        </div>

        <h2>A team, each face from its name</h2>
        <div class="hero">
            ${NAMES.map(
                (name, index) => html`
                    <div class="cell">
                        <${Face}
                            id=${name}
                            color=${DEFAULT_COLORS[index % DEFAULT_COLORS.length]}
                            state=${state}
                            size=${112}
                            label=${name}
                        />
                        ${name}
                    </div>
                `,
            )}
        </div>

        <h2>A crowd (48 faces, one WebGL context)</h2>
        <div class="crowd">
            ${Array.from(
                { length: 48 },
                (_, index) => html`
                    <${Face}
                        id=${`crowd-${index}`}
                        state=${STATES[index % STATES.length]}
                        size=${28}
                        label=${`bot ${index}`}
                    />
                `,
            )}
        </div>
    `;
}

render(html`<${Gallery} />`, document.getElementById("app"));
