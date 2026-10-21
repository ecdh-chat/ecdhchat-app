const SVG = 'http://www.w3.org/2000/svg';

// Builds elements through DOM properties and text nodes only, so nothing is parsed as HTML.
export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
}

// An SVG icon made of the given paths. It's hidden from screen readers; whatever holds it carries
// the label.
export function icon(viewBox, ...paths) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', d);
        svg.append(path);
    }
    return svg;
}
