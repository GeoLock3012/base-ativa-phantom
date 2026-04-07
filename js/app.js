(function() {
    'use strict';

    if (window.top !== window.self) { window.top.location = window.self.location; }

    let attentionStates = ["Ignição desligada", "Motor desligado", "Falha pontual de cobertura GSM", "Tensão da bateria baixa", "Bateria desconectada"];
    let currentVehiclesData = []; let currentChart = null; let currentFilter = "Todos"; let currentSearchTerm = ""; let isProcessing = false; let currentSortColumn = "status"; let currentSortDirection = "asc"; let currentPage = 1;
    
    const ITEMS_PER_PAGE = 100;
    const MAX_LINES_LIMIT = 1500000; 
    
    const statusOrder = ["Manutenção", "Verificar Frota", "Comunicação dentro de 7 dias", "Comunicação dentro de 72 horas", "Comunicação OK"];
    const statusColors = { "Comunicação OK": "#2C7A4D", "Comunicação dentro de 72 horas": "#E68A2E", "Comunicação dentro de 7 dias": "#F4B942", "Verificar Frota": "#6B4E9E", "Manutenção": "#C7362B" };
    const statusBackgrounds = { "Comunicação OK": "rgba(44, 122, 77, 0.1)", "Comunicação dentro de 72 horas": "rgba(230, 138, 46, 0.1)", "Comunicação dentro de 7 dias": "rgba(244, 185, 66, 0.1)", "Verificar Frota": "rgba(107, 78, 158, 0.1)", "Manutenção": "rgba(199, 54, 43, 0.1)" };
    const statusIcons = { "Comunicação OK": "✅", "Comunicação dentro de 72 horas": "⏰", "Comunicação dentro de 7 dias": "📅", "Verificar Frota": "🔍", "Manutenção": "🔧" };
    const pdfBgColors = { "Comunicação OK": [232, 240, 235], "Comunicação dentro de 72 horas": [251, 241, 232], "Comunicação dentro de 7 dias": [252, 246, 234], "Verificar Frota": [238, 235, 243], "Manutenção": [247, 233, 231] };

    function clearAllCache() {
        currentVehiclesData = [];
        if (currentChart) { currentChart.destroy(); currentChart = null; }
        currentFilter = "Todos"; currentSearchTerm = ""; currentSortColumn = "status"; currentSortDirection = "asc"; currentPage = 1;
        const companyInput = document.getElementById('companyName'); if (companyInput) companyInput.value = "";
        
        const textarea = document.getElementById('rawDataInput'); if (textarea) textarea.value = "";
        
        const searchInput = document.getElementById('searchInput'); if (searchInput) searchInput.value = "";
        const nameDisplay = document.getElementById('companyNameDisplay'); if (nameDisplay) nameDisplay.textContent = "";
        
        const resultsPanel = document.getElementById('resultsPanel'); 
        if (resultsPanel) resultsPanel.classList.add('hidden');
    }
    
    function showToast(message, duration = 4000) {
        const toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = message;
        document.body.appendChild(toast); setTimeout(() => toast.remove(), duration);
    }
    
    function normalizeText(txt) { try { return String(txt).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); } catch(e) { return String(txt).toLowerCase(); } }
    
    function sanitizeExport(value) {
        let v = String(value || "").trim();
        if (/^[=+\-@]/.test(v)) { v = "'" + v; }
        return v;
    }

    function getCompanyName() {
        const input = document.getElementById('companyName'); const display = document.getElementById('companyNameDisplay'); const title = document.getElementById('dashboardTitle');
        if (!input || !display || !title) return "";
        const company = input.value.trim(); if (company) { display.textContent = `- ${company}`; title.textContent = `📊 Base Ativa - ${company}`; return company; }
        display.textContent = ""; title.textContent = "📊 Base Ativa"; return "";
    }
    
    function validateCompany() {
        const input = document.getElementById('companyName'); const errorMsg = document.getElementById('companyError');
        if (!input || !errorMsg) return false;
        const company = input.value.trim(); if (!company) { input.classList.add('error'); errorMsg.style.display = 'block'; return false; }
        input.classList.remove('error'); errorMsg.style.display = 'none'; return true;
    }
    
    function parseDateRobust(dateStr) {
        if (!dateStr) return null; dateStr = String(dateStr).trim();
        let brMatch = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})[ ]?(\d{2}):(\d{2})(?::(\d{2}))?/);
        if (brMatch) { let [_, day, month, year, hour, minute, second] = brMatch; return new Date(Date.UTC(year, month-1, day, hour, minute, second || 0)); }
        let brDateMatch = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (brDateMatch) { let [_, day, month, year] = brDateMatch; return new Date(Date.UTC(year, month-1, day, 0, 0, 0)); }
        let isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:[+-]\d{2}:?\d{2}|Z)?/);
        if (isoMatch) { let [_, year, month, day, hour, minute, second] = isoMatch; return new Date(Date.UTC(year, month-1, day, hour, minute, second || 0)); }
        return null;
    }
    
    function getHoursDiff(lastCommStr) {
        const lastDate = parseDateRobust(lastCommStr); if (!lastDate || isNaN(lastDate)) return null;
        const now = new Date(); let diffMs = now - lastDate; if (diffMs < 0) return null;
        return diffMs / (1000 * 3600);
    }
    
    function determineStatus(lastCommStr, attentionFound) {
        const hours = getHoursDiff(lastCommStr);
        if (hours !== null && hours <= 24) { return { status: "Comunicação OK", type: "ok" }; }
        if (hours !== null && hours <= 72) { return { status: "Comunicação dentro de 72 horas", type: "72h" }; }
        if (hours !== null && hours <= 168) { return { status: "Comunicação dentro de 7 dias", type: "7d" }; }
        if (hours === null || hours > 168) { if (attentionFound) return { status: "Verificar Frota", type: "verificar", detailState: attentionFound }; return { status: "Manutenção", type: "manutencao" }; }
        return { status: "Manutenção", type: "manutencao" };
    }
    
    function extractAttentionState(eventsStr) {
        if (!eventsStr) return null; let parts = String(eventsStr).split(/[,;\n]+/).map(p => p.trim()).filter(p => p.length > 0);
        for (let i = parts.length-1; i >= 0; i--) { let eventClean = normalizeText(parts[i]); for (let keyword of attentionStates) { if (eventClean.includes(normalizeText(keyword))) return parts[i].trim(); } }
        return null;
    }
    
    function getSelectedSeparator() {
        const selected = document.querySelector('input[name="separator"]:checked'); if (!selected) return '\t';
        switch(selected.value) { case 'tab': return '\t'; case 'semicolon': return ';'; case 'auto': return null; default: return null; }
    }
    
    function detectSeparator(lines) {
        const separators = ['\t', ';']; let bestSep = '\t'; let bestCount = 0;
        for (let sep of separators) { let count = 0; const escapedSep = sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); for (let line of lines.slice(0, 10)) count += (line.match(new RegExp(escapedSep, 'g')) || []).length; if (count > bestCount) { bestCount = count; bestSep = sep; } }
        return bestSep;
    }
    
    async function parseTSVDataChunked(rawText, onProgress) {
        if (!rawText) return [];
        let separator = getSelectedSeparator();
        if (separator === null) {
            let sampleLines = []; let tempIdx = 0;
            for(let i = 0; i < 10; i++) {
                let nextIdx = rawText.indexOf('\n', tempIdx);
                if (nextIdx === -1) { if (tempIdx < rawText.length) sampleLines.push(rawText.slice(tempIdx)); break; }
                sampleLines.push(rawText.slice(tempIdx, nextIdx)); tempIdx = nextIdx + 1;
            }
            separator = detectSeparator(sampleLines);
        }

        const vehicles = []; let startIndex = 0; let lineCount = 0; let isFirstLine = true;
        const totalEstimatedLines = (rawText.match(/\n/g) || []).length + 1;
        if (totalEstimatedLines > MAX_LINES_LIMIT) { throw new Error("DOS_LIMIT_EXCEEDED"); }

        while (startIndex < rawText.length) {
            let endIndex = rawText.indexOf('\n', startIndex);
            if (endIndex === -1) endIndex = rawText.length;
            let line = rawText.slice(startIndex, endIndex).trim();
            startIndex = endIndex + 1;

            if (line.length === 0) continue;
            if (isFirstLine) { isFirstLine = false; const lowerLine = line.toLowerCase(); if (lowerLine.includes('placa') || lowerLine.includes('chassi')) continue; }
            lineCount++;

            if (lineCount % 5000 === 0) {
                if (onProgress) onProgress(lineCount / totalEstimatedLines);
                await new Promise(resolve => setTimeout(resolve, 5));
            }

            if (line.length > 1500) continue;
            const cols = line.split(separator); if (cols.length < 4) continue;
            
            let placa = cols[0] ? cols[0].trim() : ""; let chassi = cols[1] ? cols[1].trim() : ""; let dataCom = cols[2] ? cols[2].trim() : ""; 
            if (placa.length > 20 || chassi.length > 50 || dataCom.length > 40) continue;
            if (placa === "") placa = "Indefinido"; if (chassi === "") chassi = "Indefinido";
            
            let estadosRaw = cols.slice(3).join(" ").trim();
            if (estadosRaw.length > 500) estadosRaw = estadosRaw.substring(0, 500);
            vehicles.push({ placa, chassi, ultimaComunicacao: dataCom, estadosRaw });
        }
        if (onProgress) onProgress(1); return vehicles;
    }
    
    async function processSyncChunked(vehicles, onProgress) {
        const processed = []; const total = vehicles.length;
        for (let i = 0; i < total; i++) {
            if (onProgress && i % 2000 === 0) { onProgress(i / total); await new Promise(resolve => setTimeout(resolve, 2)); }
            const v = vehicles[i]; const attentionFound = extractAttentionState(v.estadosRaw); const statusObj = determineStatus(v.ultimaComunicacao, attentionFound);
            v.statusFinal = statusObj.status; v.statusType = statusObj.type; v.attentionDetail = (statusObj.status === "Verificar Frota") ? (statusObj.detailState || attentionFound || "---") : "---"; processed.push(v);
        }
        processed.sort((a, b) => {
            const idxA = statusOrder.indexOf(a.statusFinal); const idxB = statusOrder.indexOf(b.statusFinal); if (idxA !== idxB) return idxA - idxB;
            const dateA = parseDateRobust(a.ultimaComunicacao) || 0; const dateB = parseDateRobust(b.ultimaComunicacao) || 0; return dateA - dateB;
        });
        if (onProgress) onProgress(1); return processed;
    }
    
    function renderStatusCards(groups, total) {
        const container = document.getElementById('statusCardsGrid'); if (!container) return; container.replaceChildren();
        const createCard = (title, count, cardClass, filterValue) => {
            const card = document.createElement('div'); card.className = cardClass;
            const nameDiv = document.createElement('div'); nameDiv.className = 'status-name'; nameDiv.textContent = title;
            const numDiv = document.createElement('div'); numDiv.className = 'status-number'; numDiv.textContent = count.toLocaleString();
            card.appendChild(nameDiv); card.appendChild(numDiv); card.addEventListener('click', () => setFilter(filterValue)); return card;
        };
        container.appendChild(createCard('📊 Total de Registros', total, 'status-card total-card', 'Todos'));
        const statusList = ["Comunicação OK", "Comunicação dentro de 72 horas", "Comunicação dentro de 7 dias", "Verificar Frota", "Manutenção"];
        statusList.forEach(status => {
            const count = groups[status] || 0; if (count === 0) return; let cClass = 'status-card';
            if (status === "Comunicação OK") cClass += ' ok-card'; else if (status === "Comunicação dentro de 72 horas") cClass += ' card-72h';
            else if (status === "Comunicação dentro de 7 dias") cClass += ' card-7d'; else if (status === "Verificar Frota") cClass += ' verificar-card'; else if (status === "Manutenção") cClass += ' manutencao-card';
            const titleWithIcon = `${statusIcons[status] || '📌'} ${status}`; container.appendChild(createCard(titleWithIcon, count, cClass, status));
        });
    }
    
    function renderTablePage() {
        const filteredData = getFilteredData(); const totalPages = Math.max(1, Math.ceil(filteredData.length / ITEMS_PER_PAGE)); if (currentPage > totalPages) currentPage = totalPages;
        const start = (currentPage - 1) * ITEMS_PER_PAGE; const pageData = filteredData.slice(start, start + ITEMS_PER_PAGE);
        const container = document.getElementById('virtualBody'); if (!container) return; container.replaceChildren();
        for (let i = 0; i < pageData.length; i++) {
            const v = pageData[i]; if (!v) continue;
            const row = document.createElement('div'); row.className = 'virtual-row'; row.style.background = statusBackgrounds[v.statusFinal] || 'transparent';
            const cPlaca = document.createElement('div'); cPlaca.className = 'virtual-cell'; cPlaca.textContent = v.placa;
            const cChassi = document.createElement('div'); cChassi.className = 'virtual-cell'; cChassi.textContent = v.chassi;
            const cData = document.createElement('div'); cData.className = 'virtual-cell'; cData.textContent = v.ultimaComunicacao;
            const cStatus = document.createElement('div'); cStatus.className = 'virtual-cell';
            const bStatus = document.createElement('span'); const bClass = { ok: 'badge-ok', '72h': 'badge-72h', '7d': 'badge-7d', verificar: 'badge-verificar', manutencao: 'badge-manutencao' }[v.statusType];
            bStatus.className = `badge ${bClass}`; bStatus.textContent = v.statusFinal; cStatus.appendChild(bStatus);
            const cAtt = document.createElement('div'); cAtt.className = 'virtual-cell';
            if(v.attentionDetail !== "---") { const bAtt = document.createElement('span'); bAtt.className = 'badge'; bAtt.style.background = 'var(--accent-blue-light)'; bAtt.textContent = v.attentionDetail; cAtt.appendChild(bAtt); } else { cAtt.textContent = "—"; }
            row.appendChild(cPlaca); row.appendChild(cChassi); row.appendChild(cData); row.appendChild(cStatus); row.appendChild(cAtt);
            row.addEventListener('click', () => showVehicleDetails(v)); container.appendChild(row);
        }
        const startRecord = start + 1; const endRecord = Math.min(start + ITEMS_PER_PAGE, filteredData.length);
        const recordInfo = document.getElementById('recordInfo'); if(recordInfo) recordInfo.textContent = `Exibindo ${startRecord}-${endRecord} de ${filteredData.length.toLocaleString()} registros`;
        const filterCount = document.getElementById('filterCount'); if(filterCount) filterCount.textContent = `Filtro ativo: ${currentFilter === 'Todos' ? 'Nenhum' : currentFilter}`;
        renderPaginationControls(totalPages);
    }
    
    function renderPaginationControls(totalPages) {
        const container = document.getElementById('paginationControls'); if (!container) return; container.replaceChildren(); if (totalPages <= 1) return;
        const createBtn = (text, targetPage, isActive, isDisabled) => {
            const btn = document.createElement('div'); btn.className = `page-btn ${isActive ? 'active' : ''}`; btn.textContent = text;
            if (isDisabled) { btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; } else { btn.addEventListener('click', () => goToPage(targetPage)); } return btn;
        };
        container.appendChild(createBtn('◀', currentPage - 1, false, currentPage === 1));
        let startPage = Math.max(1, currentPage - 4); let endPage = Math.min(totalPages, currentPage + 4);
        if (startPage > 1) { container.appendChild(createBtn('1', 1, false, false)); if (startPage > 2) { const dots = document.createElement('span'); dots.textContent = '...'; container.appendChild(dots); } }
        for (let i = startPage; i <= endPage; i++) { container.appendChild(createBtn(i.toString(), i, currentPage === i, false)); }
        if (endPage < totalPages) { if (endPage < totalPages - 1) { const dots = document.createElement('span'); dots.textContent = '...'; container.appendChild(dots); } container.appendChild(createBtn(totalPages.toString(), totalPages, false, false)); }
        container.appendChild(createBtn('▶', currentPage + 1, false, currentPage === totalPages));
        const input = document.createElement('input'); input.type = 'number'; input.className = 'page-input'; input.min = '1'; input.max = totalPages.toString(); input.value = currentPage.toString(); input.id = 'dynamicPageInput'; container.appendChild(input);
        const goBtn = document.createElement('button'); goBtn.className = 'page-btn'; goBtn.textContent = 'Ir'; goBtn.addEventListener('click', () => { const val = parseInt(document.getElementById('dynamicPageInput').value, 10); if(!isNaN(val)) goToPage(val); }); container.appendChild(goBtn);
    }
    
    function goToPage(page) {
        const filteredData = getFilteredData(); const totalPages = Math.max(1, Math.ceil(filteredData.length / ITEMS_PER_PAGE));
        let newPage = Math.min(Math.max(1, page), totalPages); if (isNaN(newPage)) newPage = 1;
        currentPage = newPage; renderTablePage(); const tableContainer = document.getElementById('tableContainer'); if (tableContainer) tableContainer.scrollTop = 0;
    }
    
    function renderResults() {
        const groups = { "Comunicação OK": 0, "Comunicação dentro de 72 horas": 0, "Comunicação dentro de 7 dias": 0, "Verificar Frota": 0, "Manutenção": 0 };
        for (let v of currentVehiclesData) groups[v.statusFinal]++;
        const total = currentVehiclesData.length; renderStatusCards(groups, total);
        const tbody = document.getElementById('statusSummaryBody');
        if(tbody) {
            tbody.replaceChildren();
            for (let [status, count] of Object.entries(groups)) {
                if (count === 0) continue; const percent = (count / total * 100).toFixed(1);
                const row = document.createElement('tr'); row.style.backgroundColor = statusBackgrounds[status];
                const tdStatus = document.createElement('td'); const stStrong = document.createElement('strong'); stStrong.textContent = status; tdStatus.appendChild(stStrong);
                const tdCount = document.createElement('td'); tdCount.textContent = count.toLocaleString(); const tdPercent = document.createElement('td'); tdPercent.textContent = `${percent}%`;
                row.appendChild(tdStatus); row.appendChild(tdCount); row.appendChild(tdPercent); row.addEventListener('click', () => setFilter(status)); tbody.appendChild(row);
            }
        }
        renderChart(groups); renderFilterBar(groups, total); currentPage = 1; renderTablePage(); getCompanyName();
        const sortInfo = document.getElementById('sortInfo'); if(sortInfo) sortInfo.textContent = `Ordenação: ${currentSortColumn} ${currentSortDirection === 'asc' ? '↑' : '↓'}`;
    }
    
    function renderChart(groups) {
        const ctx = document.getElementById('donutChart'); if (!ctx) return;
        const labels = Object.entries(groups).filter(([_, count]) => count > 0).map(([status]) => status); const counts = Object.entries(groups).filter(([_, count]) => count > 0).map(([_, count]) => count);
        try {
            if (currentChart) { currentChart.destroy(); currentChart = null; }
            if (window.Chart && labels.length > 0) {
                currentChart = new Chart(ctx, {
                    type: 'doughnut', data: { labels, datasets: [{ data: counts, backgroundColor: labels.map(l => statusColors[l] || '#CCCCCC'), borderRadius: 0, borderWidth: 0 }] },
                    options: { responsive: true, maintainAspectRatio: true, layout: { padding: { bottom: 10 } }, plugins: { legend: { position: 'bottom', labels: { padding: 20 } } } }
                });
            }
        } catch(e) { console.warn("Chart Error:", e); }
    }
    
    function renderFilterBar(groups, total) {
        const filterBar = document.getElementById('filterBar'); if(!filterBar) return; filterBar.replaceChildren();
        const createBadge = (text, status) => { const badge = document.createElement('div'); badge.className = `filter-badge ${currentFilter === status ? 'active' : ''}`; badge.textContent = text; badge.addEventListener('click', () => setFilter(status)); return badge; };
        filterBar.appendChild(createBadge(`Todos (${total.toLocaleString()})`, 'Todos'));
        for (let [status, count] of Object.entries(groups)) { if (count === 0) continue; filterBar.appendChild(createBadge(`${status} (${count.toLocaleString()})`, status)); }
    }
    
    function getFilteredData() {
        let data = currentFilter === 'Todos' ? [...currentVehiclesData] : currentVehiclesData.filter(v => v.statusFinal === currentFilter);
        if (currentSearchTerm) { data = data.filter(v => normalizeText(v.placa).includes(currentSearchTerm) || normalizeText(v.chassi).includes(currentSearchTerm)); }
        data.sort((a, b) => {
            let valA, valB;
            switch(currentSortColumn) {
                case 'plate': valA = a.placa; valB = b.placa; break;
                case 'chassi': valA = a.chassi; valB = b.chassi; break;
                case 'date': valA = parseDateRobust(a.ultimaComunicacao) || 0; valB = parseDateRobust(b.ultimaComunicacao) || 0; return currentSortDirection === 'asc' ? valA - valB : valB - valA;
                case 'status': valA = statusOrder.indexOf(a.statusFinal); valB = statusOrder.indexOf(b.statusFinal); if (valA === -1) valA = 999; if (valB === -1) valB = 999; return currentSortDirection === 'asc' ? valA - valB : valB - valA;
                default: return 0;
            }
            if (typeof valA === 'string') return currentSortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA); return 0;
        });
        return data;
    }
    
    function setFilter(status) {
        currentFilter = status; currentPage = 1; renderTablePage();
        document.querySelectorAll('.filter-badge').forEach(badge => { badge.classList.remove('active'); if (badge.textContent.startsWith(status === 'Todos' ? 'Todos' : status)) badge.classList.add('active'); });
        const groups = { "Comunicação OK": 0, "Comunicação dentro de 72 horas": 0, "Comunicação dentro de 7 dias": 0, "Verificar Frota": 0, "Manutenção": 0 };
        for (let v of currentVehiclesData) groups[v.statusFinal]++; renderFilterBar(groups, currentVehiclesData.length);
    }
    
    function applySearch() { const input = document.getElementById('searchInput'); if(input) { currentSearchTerm = normalizeText(input.value); currentPage = 1; renderTablePage(); } }
    
    function showVehicleDetails(vehicle) {
        const modal = document.getElementById('vehicleModal'); const modalBody = document.getElementById('modalBody'); if (!modal || !modalBody) return;
        modalBody.replaceChildren();
        const buildRow = (label, value, isSmall = false) => {
            const row = document.createElement('div'); row.className = 'modal-detail-row'; const strong = document.createElement('strong'); strong.className = 'modal-detail-label'; strong.textContent = label; row.appendChild(strong);
            if(isSmall) { const br = document.createElement('br'); row.appendChild(br); const small = document.createElement('small'); small.className = 'modal-detail-small'; small.textContent = value; row.appendChild(small); } 
            else { const valNode = document.createElement('span'); valNode.className = 'modal-detail-value'; valNode.textContent = value; row.appendChild(valNode); } return row;
        };
        modalBody.appendChild(buildRow('Placa:', vehicle.placa)); modalBody.appendChild(buildRow('Chassi:', vehicle.chassi)); modalBody.appendChild(buildRow('Última Comunicação:', vehicle.ultimaComunicacao));
        modalBody.appendChild(buildRow('Status:', vehicle.statusFinal)); modalBody.appendChild(buildRow('Estado de Atenção:', vehicle.attentionDetail)); modalBody.appendChild(buildRow('Informações Originais:', vehicle.estadosRaw || "—", true));
        
        modal.classList.remove('hidden');
    }
    
    function closeModal() { const modal = document.getElementById('vehicleModal'); if(modal) modal.classList.add('hidden'); }
    
    async function executeBaseProcessing() {
        if (!validateCompany()) { showToast("Atenção: O nome da empresa é obrigatório.", 3000); return; }
        if (isProcessing) { showToast("Processamento já em andamento."); return; }
        
        const textAreaEl = document.getElementById('rawDataInput');
        const rawText = textAreaEl ? textAreaEl.value : ""; 
        
        if (!rawText.trim()) { 
            alert("Nenhum dado válido carregado no sistema."); 
            return; 
        }
        
        isProcessing = true;
        const processBtn = document.getElementById('processBtn'); const pdfBtn = document.getElementById('exportPdfBtn'); const csvBtn = document.getElementById('exportCsvBtn'); const excelBtn = document.getElementById('exportExcelBtn');
        if(processBtn) { processBtn.disabled = true; processBtn.textContent = "Processando..."; } if(pdfBtn) pdfBtn.disabled = true; if(csvBtn) csvBtn.disabled = true; if(excelBtn) excelBtn.disabled = true;
        
        const progressContainer = document.getElementById('progressContainer'); const progressFill = document.getElementById('progressFill'); const progressText = document.getElementById('progressText');
        
        if(progressContainer) progressContainer.classList.remove('hidden'); 
        if(progressFill) progressFill.style.width = '0%'; if(progressText) progressText.textContent = "Extraindo dados...";
        
        try {
            if(progressText) progressText.textContent = "Estruturando informações...";
            const vehicles = await parseTSVDataChunked(rawText, (pct) => { if(progressFill) progressFill.style.width = `${pct * 40}%`; if(progressText) progressText.textContent = `Carregamento estrutural: ${Math.round(pct * 100)}%`; });
            if (vehicles.length === 0) { alert("Nenhum dado válido identificado de acordo com os parâmetros."); throw new Error("Dataset empty"); }
            if(progressText) progressText.textContent = `Avaliando ${vehicles.length.toLocaleString()} registros identificados...`; if(progressFill) progressFill.style.width = '50%';
            const processed = await processSyncChunked(vehicles, (pct) => { if(progressFill) progressFill.style.width = `${50 + pct * 50}%`; if(progressText) progressText.textContent = `Motor de regras em execução: ${Math.round(pct * 100)}%`; });
            
            currentVehiclesData = processed; currentFilter = "Todos"; currentSearchTerm = ""; currentSortColumn = "status"; currentSortDirection = "asc"; currentPage = 1;
            const searchInput = document.getElementById('searchInput'); if (searchInput) searchInput.value = ""; renderResults();
            
            const resultsPanel = document.getElementById('resultsPanel'); if(resultsPanel) resultsPanel.classList.remove('hidden');
            
            if(pdfBtn) pdfBtn.disabled = false; if(csvBtn) csvBtn.disabled = false; if(excelBtn) excelBtn.disabled = false; showToast(`Análise concluída. ${processed.length.toLocaleString()} resultados verificados.`);
        } catch(e) { 
            console.error(e); 
            if (e.message === "DOS_LIMIT_EXCEEDED") { alert(`Segurança Ativa: Limite máximo de ${MAX_LINES_LIMIT.toLocaleString()} registros excedido. Divida a extração.`); } 
            else { alert("Falha durante o processamento de dados."); }
        } 
        finally { 
            isProcessing = false; 
            if(processBtn) { processBtn.disabled = false; processBtn.textContent = "🔍 Processar Base"; } 
            if(progressContainer) progressContainer.classList.add('hidden'); 
        }
    }
    
    async function exportToPDF() {
        if (!currentVehiclesData.length) { alert("A base precisa ser processada antes da emissão de documentos."); return; }
        const companyName = getCompanyName(); const reportTitle = companyName ? `Base Ativa - ${companyName}` : "Base Ativa"; const dataToExport = getFilteredData();
        if (dataToExport.length > 5000) { if (!confirm(`Aviso de Sistema: Confirma a geração do relatório integral contendo ${dataToExport.length.toLocaleString()} registros?`)) return; }
        const limitToShow = dataToExport.length;
        
        try {
            if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) { showToast("Componente PDF offline ou não acessível.", 3000); return; }
            const pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
            pdf.setFontSize(20); pdf.text(reportTitle, 20, 20); pdf.setFontSize(10); pdf.text(`Relatório gerado em: ${new Date().toLocaleString()}`, 20, 30); pdf.text(`Registros incluídos na exportação: ${dataToExport.length.toLocaleString()}`, 20, 37);
            const groups = { "Comunicação OK": 0, "Comunicação dentro de 72 horas": 0, "Comunicação dentro de 7 dias": 0, "Verificar Frota": 0, "Manutenção": 0 };
            for (let v of dataToExport) groups[v.statusFinal]++;
            
            try {
                const tempCanvas = document.createElement('canvas'); tempCanvas.width = 1200; tempCanvas.height = 1200;
                const tempCtx = tempCanvas.getContext('2d'); tempCtx.fillStyle = '#FFFFFF'; tempCtx.fillRect(0, 0, 1200, 1200);
                const labels = Object.entries(groups).filter(([_, count]) => count > 0).map(([status]) => status); const counts = Object.entries(groups).filter(([_, count]) => count > 0).map(([_, count]) => count);
                if (typeof window.Chart !== 'undefined' && labels.length > 0) {
                    const tempChart = new window.Chart(tempCtx, { type: 'doughnut', data: { labels: labels, datasets: [{ data: counts, backgroundColor: labels.map(l => statusColors[l] || '#CCCCCC'), borderRadius: 0, borderWidth: 0 }] }, options: { responsive: false, animation: false, layout: { padding: { bottom: 20 } }, plugins: { legend: { position: 'bottom', labels: { font: { size: 28 }, padding: 40 } } } } });
                    const chartImageHD = tempCanvas.toDataURL('image/png', 1.0); pdf.addImage(chartImageHD, 'PNG', 20, 45, 85, 85); tempChart.destroy();
                }
            } catch(e) { console.warn("Chart injection bypassed:", e); }

            let y = 50; pdf.setFontSize(11); pdf.text("Resumo por Categoria:", 115, y); y += 8;
            const startX = 115; const colWidths = [70, 40, 40]; const tableWidth = 150;
            const c0 = startX + (colWidths[0] / 2); const c1 = startX + colWidths[0] + (colWidths[1] / 2); const c2 = startX + colWidths[0] + colWidths[1] + (colWidths[2] / 2);
            pdf.setFontSize(9); pdf.setFillColor(240, 240, 240); pdf.rect(startX, y - 5, tableWidth, 8, 'F');
            
            pdf.setFont("helvetica", "bold"); 
            pdf.text("Status", c0, y + 0.5, { align: 'center' }); 
            pdf.text("Ocorrências", c1, y + 0.5, { align: 'center' }); 
            pdf.text("Volume (%)", c2, y + 0.5, { align: 'center' }); 
            y += 8.5;

            for (let [status, count] of Object.entries(groups)) {
                if (count === 0) continue; const percent = (count / dataToExport.length * 100).toFixed(1);
                if(pdfBgColors[status]) { pdf.setFillColor(...pdfBgColors[status]); pdf.rect(startX, y - 5, tableWidth, 8, 'F'); }
                pdf.setTextColor(26, 44, 62); 
                pdf.setFont("helvetica", "bold"); 
                pdf.text(status.substring(0, 35), c0, y, { align: 'center' });
                pdf.setFont("helvetica", "normal"); 
                pdf.text(count.toLocaleString(), c1, y, { align: 'center' }); 
                pdf.text(`${percent}%`, c2, y, { align: 'center' }); 
                y += 8.5;
                if (y > 185) { 
                    pdf.addPage(); y = 20; pdf.setFillColor(240, 240, 240); pdf.rect(startX, y - 5, tableWidth, 8, 'F'); 
                    pdf.setFont("helvetica", "bold"); 
                    pdf.text("Status", c0, y + 0.5, { align: 'center' }); 
                    pdf.text("Ocorrências", c1, y + 0.5, { align: 'center' }); 
                    pdf.text("Volume (%)", c2, y + 0.5, { align: 'center' }); 
                    y += 8.5; 
                }
            }
            
            pdf.setTextColor(0,0,0); pdf.addPage(); let pageY = 20; pdf.setFontSize(14); 
            pdf.setFont("helvetica", "bold"); 
            pdf.text(`Análise de Ocorrências`, 20, pageY); pageY += 12;
            pdf.setFontSize(7); const tableHeaders = ["Placa", "Chassi", "Última Comunicação", "Status", "Estado de Atenção"]; let tableStartX = 10;
            pdf.setFillColor(240, 240, 240); pdf.rect(tableStartX, pageY, 277, 8, 'F'); 
            pdf.setFont("helvetica", "bold"); 
            tableHeaders.forEach((h, i) => { pdf.text(h, tableStartX + i*55 + 2, pageY + 5.5); }); 
            pdf.setFont("helvetica", "normal"); 
            pageY += 13;
            
            for (let i = 0; i < limitToShow; i++) {
                const v = dataToExport[i];
                if (pageY > 185) { 
                    pdf.addPage(); pageY = 20; pdf.setFillColor(240, 240, 240); pdf.rect(tableStartX, pageY, 277, 8, 'F'); 
                    pdf.setFont("helvetica", "bold"); 
                    tableHeaders.forEach((h, j) => { pdf.text(h, tableStartX + j*55 + 2, pageY + 5.5); }); 
                    pdf.setFont("helvetica", "normal"); 
                    pageY += 13; 
                }
                pdf.text((v.placa || "").substring(0, 15), tableStartX + 2, pageY); pdf.text((v.chassi || "").substring(0, 20), tableStartX + 57, pageY); pdf.text((v.ultimaComunicacao || "").substring(0, 18), tableStartX + 112, pageY);
                pdf.text(v.statusFinal.substring(0, 30), tableStartX + 167, pageY); pdf.text(v.attentionDetail !== "---" ? (v.attentionDetail || "").substring(0, 30) : "—", tableStartX + 222, pageY);
                pdf.setDrawColor(228, 233, 242); pdf.line(tableStartX, pageY + 2, tableStartX + 277, pageY + 2); pageY += 7;
            }
            pdf.save(`${reportTitle.replace(/\s/g, "_")}_${new Date().toISOString().slice(0,19)}.pdf`); showToast("Documento PDF gerado com validação estrutural.");
        } catch(e) { console.error(e); alert("Operação interrompida no pipeline PDF: " + e.message); }
    }
    
    function exportToCSV() {
        let dataToExport = getFilteredData(); if (dataToExport.length === 0) { alert("Base vazia ou inconsistente."); return; }
        const headers = ["Placa", "Chassi", "Última Comunicação", "Status", "Estado de Atenção"]; 
        const rows = dataToExport.map(v => [sanitizeExport(v.placa), sanitizeExport(v.chassi), sanitizeExport(v.ultimaComunicacao), sanitizeExport(v.statusFinal), sanitizeExport(v.attentionDetail)]);
        const csvContent = [headers, ...rows].map(row => row.map(cell => `"${String(cell || "").replace(/"/g, '""')}"`).join(";")).join("\n"); const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
        const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.setAttribute("download", `base_ativa_${new Date().toISOString().slice(0,19)}.csv`); link.click(); URL.revokeObjectURL(link.href); showToast("Arquivo CSV validado e disponibilizado.");
    }
    
    function exportToExcel() {
        let dataToExport = getFilteredData(); if (dataToExport.length === 0) { alert("Base vazia ou inconsistente."); return; }
        const wsData = [["Placa", "Chassi", "Última Comunicação", "Status", "Estado de Atenção"]]; 
        dataToExport.forEach(v => { wsData.push([sanitizeExport(v.placa), sanitizeExport(v.chassi), sanitizeExport(v.ultimaComunicacao), sanitizeExport(v.statusFinal), sanitizeExport(v.attentionDetail)]); });
        if(typeof window.XLSX === 'undefined') { alert("Módulo Excel carregando, tente novamente em 1 segundo."); return; }
        const ws = window.XLSX.utils.aoa_to_sheet(wsData); const wb = window.XLSX.utils.book_new(); window.XLSX.utils.book_append_sheet(wb, ws, "Base Ativa"); window.XLSX.writeFile(wb, `base_ativa_${new Date().toISOString().slice(0,19)}.xlsx`); showToast("Planilha enviada com integridade verificada.");
    }
    
    function initTheme() { try { const toggle = document.getElementById('darkModeToggle'); if(toggle) { document.documentElement.setAttribute('data-theme', 'light'); toggle.checked = false; toggle.addEventListener('change', (e) => { const theme = e.target.checked ? 'dark' : 'light'; document.documentElement.setAttribute('data-theme', theme); }); } } catch(e) {} }
    
    function debounce(func, wait) { let timeout; return function executedFunction(...args) { const later = () => { clearTimeout(timeout); func(...args); }; clearTimeout(timeout); timeout = setTimeout(later, wait); }; }
    
    function initializeApp() {
        clearAllCache();
        const bindEvent = (id, event, handler) => { const el = document.getElementById(id); if(el) el.addEventListener(event, handler); };
        bindEvent('processBtn', 'click', executeBaseProcessing); bindEvent('exportPdfBtn', 'click', exportToPDF); bindEvent('exportCsvBtn', 'click', exportToCSV); bindEvent('exportExcelBtn', 'click', exportToExcel); bindEvent('closeModalBtn', 'click', closeModal); bindEvent('companyName', 'change', () => { getCompanyName(); validateCompany(); });
        
        const textAreaEl = document.getElementById('rawDataInput');
        const pasteOverlay = document.getElementById('pasteOverlay');

        if (textAreaEl) {
            textAreaEl.addEventListener('paste', async (e) => {
                e.preventDefault();
                
                const text = e.clipboardData ? e.clipboardData.getData('text/plain') : (window.clipboardData ? window.clipboardData.getData('Text') : '');
                if (!text) return;

                if (pasteOverlay) pasteOverlay.classList.remove('hidden');

                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

                setTimeout(() => {
                    textAreaEl.value = text;
                    
                    requestAnimationFrame(() => {
                        if (pasteOverlay) pasteOverlay.classList.add('hidden');
                        showToast(`Dados carregados com sucesso.`, 2000);
                    });
                }, 15);
            });
        }
        
        const csvUpload = document.getElementById('csvUpload');
        if (csvUpload) {
            csvUpload.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                
                if (pasteOverlay) pasteOverlay.classList.remove('hidden');
                
                const reader = new FileReader();
                reader.onload = function(evt) {
                    const text = evt.target.result;
                    
                    setTimeout(() => {
                        if (textAreaEl) {
                            textAreaEl.value = text;
                        }
                        if (pasteOverlay) pasteOverlay.classList.add('hidden');
                        csvUpload.value = ''; 
                        showToast(`Arquivo processado com sucesso.`, 3000);
                    }, 50);
                };
                reader.onerror = function() {
                    if (pasteOverlay) pasteOverlay.classList.add('hidden');
                    showToast("Erro ao ler o arquivo.", 3000);
                };
                reader.readAsText(file);
            });
        }
        
        const searchInp = document.getElementById('searchInput'); if (searchInp) searchInp.addEventListener('keyup', debounce(applySearch, 300));
        document.querySelectorAll('.virtual-header .virtual-cell').forEach(cell => { cell.addEventListener('click', () => { const sortKey = cell.getAttribute('data-sort'); if (sortKey) { if (currentSortColumn === sortKey) currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc'; else { currentSortColumn = sortKey; currentSortDirection = 'asc'; } currentPage = 1; renderTablePage(); const sInfo = document.getElementById('sortInfo'); if(sInfo) sInfo.textContent = `Ordenação: ${currentSortColumn} ${currentSortDirection === 'asc' ? '↑' : '↓'}`; } }); });
        
        initTheme(); window.addEventListener('click', (e) => { const modal = document.getElementById('vehicleModal'); if (e.target === modal) closeModal(); });
    }

    function bootSystem() {
        let progress = 0;
        let isAppReady = false;
        let scriptsVerified = false;

        const fill = document.getElementById('loaderProgressFill');
        const text = document.getElementById('loaderMessage');
        const loader = document.getElementById('appLoader');

        const updateUI = (p) => {
            if (isAppReady) return;
            if (p > 100) p = 100;
            if (fill) fill.style.width = `${p}%`;
            if (text) {
                if (p <= 30) text.textContent = "Inicializando módulos...";
                else if (p <= 60) text.textContent = "Carregando bibliotecas de análise...";
                else if (p <= 90) text.textContent = "Preparando ambiente...";
                else if (p < 100) text.textContent = "Quase lá...";
                else text.textContent = "Pronto! Redirecionando...";
            }
        };

        const finishLoading = () => {
            if (isAppReady) return;
            isAppReady = true;
            updateUI(100);

            setTimeout(() => {
                if (loader) {
                    loader.classList.add('fade-out');
                    setTimeout(() => loader.remove(), 500); 
                }
                document.body.classList.add('app-ready');
                initializeApp(); 
            }, 500);
        };

        const visualInterval = setInterval(() => {
            if (progress < 90) {
                progress += Math.floor(Math.random() * 12) + 3;
                updateUI(progress);
            } else if (scriptsVerified) {
                clearInterval(visualInterval);
                finishLoading();
            }
        }, 100);

        const checkLibs = setInterval(() => {
            if (typeof window.Chart !== 'undefined' && typeof window.jspdf !== 'undefined' && typeof window.XLSX !== 'undefined') {
                scriptsVerified = true;
                clearInterval(checkLibs);
            }
        }, 100);

        setTimeout(() => {
            if (!isAppReady) {
                scriptsVerified = true;
                clearInterval(checkLibs);
            }
        }, 8000);
    }

    window.addEventListener('DOMContentLoaded', bootSystem);

})();
