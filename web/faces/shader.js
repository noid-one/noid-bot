// The face shader (WebGL2, GLSL ES 3.00). One full-screen triangle; everything is drawn from signed distances in the
// fragment shader: a soft shadow, the glow, the body (a rippled shape, the same as `bodyRadius` in params.js), its
// skin's shading, and the eyes. Output is premultiplied alpha on a transparent background.

export const VERTEX = `#version 300 es
void main() {
    // A triangle that covers the viewport: (-1,-1), (3,-1), (-1,3).
    vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAGMENT = `#version 300 es
precision highp float;

uniform vec2 u_resolution;
uniform float u_clock;
uniform float u_time;
uniform float u_ripple;
uniform vec3 u_amp;
uniform vec3 u_phase;
uniform float u_roundness;
uniform float u_aspect;
uniform int u_shape;
uniform float u_center;
uniform vec2 u_offset;
uniform vec2 u_squash;
uniform float u_tilt;
uniform vec3 u_base;
uniform vec3 u_light;
uniform vec3 u_dark;
uniform vec3 u_eyeColor;
uniform vec3 u_glowColor;
uniform float u_glow;
uniform float u_dim;
uniform float u_open;
uniform vec2 u_look;
uniform float u_smile;
uniform float u_sad;
uniform float u_eyeHeight;
uniform float u_eyeGap;
uniform vec3 u_nose;
uniform int u_skin;
uniform int u_eyes;

out vec4 outColor;

const float PI = 3.14159265;
const vec3 LIGHT = normalize(vec3(-0.45, 0.65, 0.75));

mat2 rotation(float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return mat2(c, s, -s, c);
}

float bump(float offset, float width) {
    return exp(-(offset * offset) / (width * width));
}

float plateau(float offset, float width) {
    return exp(-pow(abs(offset) / width, 4.0));
}

// params.js floppyEar: a dog's ear by the angle from its middle.
float floppyEar(float offset) {
    return (1.0 - smoothstep(0.15, 0.95, offset)) * smoothstep(-0.62, -0.42, offset);
}

float tent(float offset, float width) {
    return max(0.0, 1.0 - abs(offset) / width);
}

// The angle between two angles, from -PI to PI.
float turn(float from, float to) {
    return mod(from - to + PI, 2.0 * PI) - PI;
}

float smoothMin(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
}

// params.js starRadius: points at radius outer, and between each two a point at radius inner.
float starRadius(float theta, float sides, float outer, float inner, float start) {
    float sector = 2.0 * PI / sides;
    float phi = mod(theta - start, sector);
    phi = phi > sector * 0.5 ? sector - phi : phi;
    float edgeX = inner * cos(sector * 0.5) - outer;
    float edgeY = inner * sin(sector * 0.5);
    return (outer * edgeY) / (cos(phi) * edgeY - sin(phi) * edgeX);
}

float polygon(float theta, float sides, float outer, float start, float round_) {
    return smoothMin(starRadius(theta, sides, outer, outer * cos(PI / sides), start), outer, round_);
}

float superellipse(float theta, float exponent, float wide) {
    float x = abs(cos(theta)) / wide;
    float y = abs(sin(theta));
    return 1.0 / pow(pow(x, exponent) + pow(y, exponent), 1.0 / exponent);
}

// The shape's radius toward theta: params.js shapeRadius, line for line, with shapes by their index in SHAPES.
float shapeRadius(float theta) {
    float up = turn(theta, PI * 0.5);

    if (u_shape == 1) {
        return 0.47 * superellipse(theta, 7.0, 1.14);
    } else if (u_shape == 2) {
        return polygon(theta, 3.0, 0.7, PI * 0.5, 0.14);
    } else if (u_shape == 3) {
        return polygon(theta, 4.0, 0.62, PI * 0.5, 0.08);
    } else if (u_shape == 4) {
        return polygon(theta, 5.0, 0.57, PI * 0.5, 0.08);
    } else if (u_shape == 5) {
        return polygon(theta, 6.0, 0.55, 0.0, 0.06);
    } else if (u_shape == 6) {
        return polygon(theta, 8.0, 0.53, PI / 8.0, 0.04);
    } else if (u_shape == 7) {
        return smoothMin(starRadius(theta, 5.0, 0.7, 0.38, PI * 0.5), 0.66, 0.08);
    } else if (u_shape == 8) {
        return 0.41 + 0.13 * sqrt(abs(cos(3.0 * up)));
    } else if (u_shape == 9) {
        float down = turn(theta, -PI * 0.5);
        float lobes = 1.0
            - 0.08 * bump(up, 0.3)
            - 0.09 * (bump(up - 0.8, 0.14) + bump(up + 0.8, 0.14))
            - 0.05 * (bump(down - 0.85, 0.2) + bump(down + 0.85, 0.2));
        float stem = 0.14 * plateau(turn(theta, PI * 0.5 - 0.05), 0.11);
        return 0.48 * superellipse(theta, 2.3, 1.2) * lobes + stem;
    } else if (u_shape == 10) {
        return 0.47 * superellipse(theta, 2.2, 1.06)
            + 0.23 * tent(turn(theta, PI * 0.5 - 0.62), 0.3)
            + 0.23 * tent(turn(theta, PI * 0.5 + 0.62), 0.3);
    } else if (u_shape == 11) {
        return 0.43 * superellipse(theta, 2.2, 0.86)
            + 0.15 * floppyEar(turn(theta, 0.3))
            + 0.15 * floppyEar(turn(PI - theta, 0.3))
            + 0.04 * bump(turn(theta, -PI * 0.5), 0.4);
    } else if (u_shape == 12) {
        float radius = 0.44;
        float apex = 0.76;
        float touch = asin(radius / apex);
        if (abs(up) >= PI * 0.5 - touch) {
            return radius;
        }
        float side = up < 0.0 ? 1.0 : -1.0;
        float toX = side * radius * cos(touch);
        float toY = radius * sin(touch) - apex;
        return (-apex * toX) / (cos(theta) * toY - sin(theta) * toX);
    } else if (u_shape == 13) {
        float puffs = 0.15 * sqrt(abs(cos(2.5 * up)));
        float top = clamp((sin(theta) + 0.15) / 0.45, 0.0, 1.0);
        return 0.38 * superellipse(theta, 3.0, 1.4) + puffs * top * top;
    } else if (u_shape == 14) {
        float down = turn(theta, -PI * 0.5);
        float below = max(0.0, -sin(theta));
        float hem = 0.12 * sqrt(abs(cos(3.5 * down))) * smoothstep(0.4, 0.85, below);
        return 0.44 * superellipse(theta, sin(theta) > 0.0 ? 2.1 : 4.5, 0.88) * (1.0 + 0.16 * below) + hem;
    }

    return 0.5 * superellipse(theta, u_roundness, 1.0);
}

// The body's radius toward angle theta: params.js bodyRadius, line for line.
float bodyRadius(float theta) {
    float along = atan(sin(theta) * u_aspect, cos(theta));
    float stretch = length(vec2(cos(along) * u_aspect, sin(along)));
    float shape = shapeRadius(along) * stretch;
    float wave = 0.0;
    wave += u_amp.x * u_ripple * sin(2.0 * theta + u_phase.x + u_time * 0.7);
    wave += u_amp.y * u_ripple * sin(3.0 * theta + u_phase.y + u_time * 1.05);
    wave += u_amp.z * u_ripple * sin(4.0 * theta + u_phase.z + u_time * 1.4);
    return shape * (1.0 + wave);
}

float roundedBox(vec2 p, vec2 half_, float radius) {
    vec2 q = abs(p) - half_ + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec3 rainbow(float t) {
    return 0.55 + 0.45 * cos(2.0 * PI * (t + vec3(0.0, 0.33, 0.67)));
}

// One eye's distance at local point e (its center at the origin), for the capsule and dot styles.
float eyeShape(vec2 e, vec2 half_, float side) {
    // Upset eyes droop at their outer corners.
    e = rotation(side * u_sad * 0.35) * e;
    float open = max(u_open, 0.07);
    vec2 size = vec2(half_.x, half_.y * open);
    float shape = roundedBox(e, size, min(size.x, size.y));
    // Happy eyes: an arch, like ^ ^.
    vec2 a = e + vec2(0.0, 0.035);
    float arch = abs(length(a) - half_.x * 1.25) - half_.x * 0.38;
    arch = a.y < 0.0 ? max(arch, length(vec2(abs(a.x) - half_.x * 1.25, a.y)) - half_.x * 0.38) : arch;
    return mix(shape, arch, u_smile);
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    vec2 p = (uv * 2.0 - 1.0) * 0.8;

    // Pixel skin: draw on a coarse grid.
    if (u_skin == 4) {
        float cells = clamp(u_resolution.x / 5.0, 14.0, 26.0);
        p = (floor((uv * 2.0 - 1.0) * cells * 0.5) + 0.5) / (cells * 0.5) * 0.8;
    }

    float aa = 2.0 * 0.8 * 1.25 / u_resolution.x;

    // The body's own space: moved, tilted, and squashed about its base so it stays on the ground.
    vec2 b = p - u_offset - vec2(0.0, -0.04);
    b = rotation(-u_tilt) * b;
    b.y = (b.y + 0.5) / u_squash.y - 0.5;
    b.x /= u_squash.x;

    // The shape is drawn about its own middle, u_center up from the body's.
    vec2 c = b - vec2(0.0, u_center);
    float theta = atan(c.y, c.x);
    float radius = bodyRadius(theta);
    float dist = length(c) - radius;
    float body = 1.0 - smoothstep(-aa, aa, dist);

    // A shadow on the ground, smaller when the body is up in the air.
    float lift = clamp(u_offset.y * 6.0, 0.0, 0.8);
    vec2 ground = (p - vec2(u_offset.x, -0.6)) / vec2(0.36 * u_aspect * (1.0 - lift * 0.4), 0.055);
    float shadow = (1.0 - smoothstep(0.2, 1.0, length(ground))) * 0.3 * (1.0 - lift);

    // The glow around the body: the state's color, breathing.
    float pulse = 0.75 + 0.25 * sin(u_clock * 3.0);
    float glow = exp(-max(dist, 0.0) * 18.0) * u_glow * pulse * (1.0 - body);

    // Shading. s is how far out from the middle (1 at the edge); the dome gives a normal.
    float s = clamp(length(c) / radius, 0.0, 1.0);
    vec2 outward = length(c) > 0.0 ? normalize(c) : vec2(0.0);
    float flat_ = u_eyes == 1 ? 0.75 : 0.9;
    vec3 normal = normalize(vec3(outward * s * flat_, sqrt(max(1.0 - s * s, 0.0)) + 0.15));
    float diffuse = max(dot(normal, LIGHT), 0.0);
    vec3 halfway = normalize(LIGHT + vec3(0.0, 0.0, 1.0));
    float rim = pow(1.0 - normal.z, 2.5);
    vec3 ramp = mix(u_dark, u_light, smoothstep(-0.7, 0.8, normal.y * 0.7 - normal.x * 0.3 + 0.1));
    vec3 color;

    if (u_skin == 1) {
        // Clay: matte, soft half-lambert, a little grain.
        float soft = diffuse * 0.55 + 0.45;
        color = mix(u_dark, u_base, soft) * (0.92 + 0.16 * soft);
        color += (hash(floor(gl_FragCoord.xy)) - 0.5) * 0.035;
        color *= 1.0 - 0.18 * smoothstep(0.1, -0.5, b.y) * s;
    } else if (u_skin == 2) {
        // Chrome: a mirrored sky and ground, tinted by the bot's color.
        vec3 reflected = reflect(vec3(0.0, 0.0, -1.0), normal);
        float horizon = smoothstep(-0.35, 0.3, reflected.y);
        vec3 sky = mix(u_base, mix(u_light, vec3(1.0), 0.45), 0.35 + 0.65 * max(reflected.y, 0.0));
        vec3 floor_ = mix(u_dark * 0.45, u_base * 0.8, 0.5 + 0.5 * reflected.y);
        color = mix(floor_, sky, horizon);
        // Studio lights reflected as soft bands.
        color += 0.22 * exp(-abs(reflected.y - 0.05) * 14.0);
        color += 0.12 * exp(-abs(reflected.x + 0.45) * 10.0) * horizon;
        color += pow(max(dot(normal, halfway), 0.0), 90.0) * 1.2;
    } else if (u_skin == 3) {
        // Hologram: color that shifts with the angle and over time, bright at the edges.
        float shift = dot(normal.xy, vec2(0.6, 0.45)) + u_clock * 0.06 + s * 0.35;
        vec3 film = rainbow(shift);
        color = mix(ramp, film, 0.35 + 0.45 * rim);
        color += pow(max(dot(normal, halfway), 0.0), 50.0) * 0.8;
        color += 0.02 * sin(gl_FragCoord.y * 1.2 + u_clock * 8.0);
    } else if (u_skin == 4) {
        // Pixel: three tones and a dark outline.
        float tone = diffuse * 0.8 + (1.0 - s) * 0.3;
        color = tone > 0.62 ? u_light : tone > 0.34 ? u_base : u_dark;
        color = dist > -aa * 3.0 ? u_dark * 0.55 : color;
    } else {
        // Jelly: glossy and a little translucent, lit from inside near the middle.
        color = ramp * (0.6 + 0.5 * diffuse);
        color = mix(color, u_light, pow(1.0 - s, 2.0) * 0.25);
        color += pow(max(dot(normal, halfway), 0.0), 36.0) * 0.75;
        color += rim * u_glowColor * 0.35;
        // A soft window highlight, up and to the left.
        vec2 spot = (b - vec2(-0.17 * u_aspect, 0.2)) / vec2(0.1, 0.06);
        color += (1.0 - smoothstep(0.3, 1.0, length(spot))) * 0.35;
    }

    // Eyes, in body space so they squash and tilt with it.
    vec2 look = u_look * vec2(0.07, 0.05);
    vec2 center = vec2(0.0, u_eyeHeight - u_sad * 0.03) + look;
    float gap = u_eyeGap * min(u_aspect, 1.05);
    vec2 left = b - center + vec2(gap, 0.0);
    vec2 right = b - center - vec2(gap, 0.0);
    vec3 eyeColor = u_eyeColor;
    float eyes;
    float shine = 0.0;

    if (u_eyes == 1) {
        // Visor: a dark glossy band, with eyes that glow inside it.
        vec2 visorCenter = vec2(0.0, u_eyeHeight - 0.005);
        float visor = roundedBox(b - visorCenter, vec2(0.34 * u_aspect, 0.13), 0.1);
        float inVisor = 1.0 - smoothstep(-aa, aa, visor);
        vec3 glass = mix(vec3(0.03, 0.035, 0.05), u_dark * 0.25, 0.4);
        float streak = 1.0 - smoothstep(0.0, 0.02, abs((b.x - visorCenter.x) * 0.6 + (b.y - visorCenter.y) - 0.06));
        glass += streak * 0.08;
        color = mix(color, glass, inVisor);
        vec2 eyeLook = u_look * vec2(0.09, 0.04);
        float le = eyeShape(b - center - eyeLook + look + vec2(gap * 0.9, 0.0), vec2(0.055, 0.07), 1.0);
        float re = eyeShape(b - center - eyeLook + look - vec2(gap * 0.9, 0.0), vec2(0.055, 0.07), -1.0);
        eyes = min(le, re);
        eyeColor = mix(u_glowColor, vec3(1.0), 0.55);
        // The eyes' light spills a little around them.
        color += exp(-max(eyes, 0.0) * 55.0) * u_glowColor * 0.55 * inVisor;
    } else if (u_eyes == 2) {
        eyes = min(eyeShape(left, vec2(0.05, 0.05), 1.0), eyeShape(right, vec2(0.05, 0.05), -1.0));
    } else {
        eyes = min(eyeShape(left, vec2(0.065, 0.105), 1.0), eyeShape(right, vec2(0.065, 0.105), -1.0));
        // A small catch-light in each open eye.
        vec2 catchLight = vec2(-0.022, 0.05 * max(u_open, 0.0));
        float lights = min(length(left - catchLight), length(right - catchLight)) - 0.021;
        shine = (1.0 - smoothstep(-aa, aa, lights)) * smoothstep(0.35, 0.8, u_open) * (1.0 - u_smile);
    }

    float eyeMask = 1.0 - smoothstep(-aa, aa, eyes);
    color = mix(color, eyeColor, eyeMask);

    // An animal's nose, under its eyes.
    if (u_nose.x > 0.0) {
        float nose = (length((b - center + vec2(0.0, u_nose.z)) / u_nose.xy) - 1.0) * min(u_nose.x, u_nose.y);
        color = mix(color, u_eyeColor, 1.0 - smoothstep(-aa, aa, nose));
    }
    color = mix(color, vec3(1.0), shine * 0.9);

    // Asleep or upset: dimmer and greyer.
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(color, vec3(luma) * 0.75, u_dim);

    // Compose, premultiplied: shadow, then glow, then the body over both.
    vec4 below = vec4(vec3(0.0), shadow);
    below.rgb += u_glowColor * glow;
    below.a = max(below.a, glow * 0.9);
    vec4 result = below * (1.0 - body) + vec4(clamp(color, 0.0, 1.0), 1.0) * body;
    outColor = result;
}
`;
