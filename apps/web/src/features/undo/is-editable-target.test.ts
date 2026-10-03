import { expect, test } from 'vitest';
import { isEditableTarget } from './is-editable-target';

test('поля сохраняют родную отмену', () => {
  for (const html of [
    '<input type="text">',
    '<input type="search">',
    '<input type="number">',
    '<input type="date">',
    '<textarea></textarea>',
    '<select></select>',
    '<div contenteditable="true"><span></span></div>',
    '<div class="ProseMirror"><span></span></div>',
    '<div role="textbox"><span></span></div>',
  ]) {
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(isEditableTarget(host.querySelector('span') ?? host.firstElementChild)).toBe(true);
  }
  for (const html of ['<button></button>', '<input type="checkbox">', '<input type="radio">']) {
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(isEditableTarget(host.firstElementChild)).toBe(false);
  }
  expect(isEditableTarget(document.body)).toBe(false);
  expect(isEditableTarget(null)).toBe(false);
});
