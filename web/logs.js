document.addEventListener('DOMContentLoaded', () => {
  fetch('/api/logs')
    .then(response => response.json())
    .then(data => {
      const logContainer = document.getElementById('log-container');
      logContainer.textContent = JSON.stringify(data, null, 2);
    })
    .catch(error => {
      console.error('Error fetching logs:', error);
      const logContainer = document.getElementById('log-container');
      logContainer.textContent = 'Error loading logs.';
    });
});
