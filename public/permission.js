const enableBtn = document.getElementById('enable-btn');
const closeBtn = document.getElementById('close-btn');
const status = document.getElementById('status');

function setStatus(text, kind) {
  status.textContent = text;
  status.className = `status ${kind}`;
}

enableBtn.addEventListener('click', async () => {
  enableBtn.disabled = true;
  setStatus('Requesting…', 'pending');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());

    setStatus('Voice enabled. Shadow can hear you now.', 'success');
    enableBtn.style.display = 'none';
    closeBtn.style.display = 'block';
  } catch (err) {
    setStatus('Microphone access denied. Check your browser site settings and try again.', 'error');
    enableBtn.disabled = false;
  }
});

closeBtn.addEventListener('click', () => {
  window.close();
});
