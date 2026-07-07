function toggleMode(){var l=document.body.classList.toggle('light');document.getElementById('tl').textContent=l?'Dark':'Light';localStorage.setItem('spiritpoles-theme',l?'light':'dark')}
(function(){if(localStorage.getItem('spiritpoles-theme')==='light'){document.body.classList.add('light');document.getElementById('tl').textContent='Dark'}})();
