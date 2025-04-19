document.addEventListener('DOMContentLoaded', function() {
    // 为所有复制按钮添加事件监听器
    const copyButtons = document.querySelectorAll('.copy-button');
    copyButtons.forEach(button => {
        button.addEventListener('click', function() {
            const targetId = this.getAttribute('data-clipboard-target');
            const codeBlock = document.querySelector(targetId);
            const textToCopy = codeBlock.innerText;
            
            navigator.clipboard.writeText(textToCopy).then(() => {
                const button = this;
                const originalIcon = button.querySelector('.copy-icon').outerHTML;
                button.innerHTML = '已复制！';
                button.classList.add('success');
                
                setTimeout(() => {
                    button.innerHTML = originalIcon;
                    button.classList.remove('success');
                }, 2000);
            }).catch(err => {
                console.error('复制失败:', err);
            });
        });
    });

    // 搜索框功能
    function performSearch() {
        const query = document.getElementById('search-input').value;
        if (query) {
            window.location.href = '/search?q=' + encodeURIComponent(query);
        }
    }

    const searchButton = document.getElementById('search-button');
    const searchInput = document.getElementById('search-input');

    if (searchButton) {
        searchButton.addEventListener('click', performSearch);
    }

    if (searchInput) {
        searchInput.addEventListener('keypress', function(event) {
            if (event.key === 'Enter') {
                performSearch();
            }
        });
    }
});