function createPlayIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M8 5.5v13l10-6.5-10-6.5Z');
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

function createPauseIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M7 5h4v14H7zm6 0h4v14h-4z');
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

function createPlayPauseIcon(isPause) {
  return isPause ? createPauseIcon() : createPlayIcon();
}
