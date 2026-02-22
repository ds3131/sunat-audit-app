let motivoChart, destinoChart;
let lastResults = [];
let sortConfig = { key: null, direction: 'asc' };

// ===== Client-side XML Extraction (mirrors lib/extractor.js) =====
function extractorXMLBrowser(xmlContent) {
    const parser = new fxparser.XMLParser({ ignoreAttributes: false });
    const jsonObj = parser.parse(xmlContent);
    const ensureSingle = (val) => Array.isArray(val) ? val[0] : val;
    const da = ensureSingle(jsonObj.DespatchAdvice);

    const getSafe = (obj, path) => {
        return path.split('.').reduce((acc, part) => {
            const current = ensureSingle(acc);
            return (current && current[part]) ? current[part] : '';
        }, obj) || '';
    };

    const getValue = (obj, path) => {
        const val = getSafe(obj, path);
        const singleVal = ensureSingle(val);
        if (singleVal === '') return '';
        if (typeof singleVal === 'object' && singleVal !== null && singleVal['#text'] !== undefined) {
            return ensureSingle(singleVal['#text']);
        }
        return singleVal;
    };

    const shipment = getSafe(da, 'cac:Shipment');
    const stage = getSafe(shipment, 'cac:ShipmentStage');
    const delivery = getSafe(da, 'cac:Shipment.cac:Delivery') || getSafe(shipment, 'cac:Delivery');

    let equipment = getSafe(shipment, 'cac:TransportHandlingUnit.cac:TransportEquipment');
    if (!getValue(equipment, 'cbc:ID')) {
        equipment = getSafe(shipment, 'cac:TransportEquipment');
    }

    const driver = getSafe(stage, 'cac:DriverPerson');
    const transportistaNombre = getValue(driver, 'cbc:FirstName');

    return {
        "FECHA EMISION": `${getValue(da, 'cbc:IssueDate')} ${getValue(da, 'cbc:IssueTime')}`.trim(),
        "FECHA ENTREGA/TRASLADO": getValue(stage, 'cac:TransitPeriod.cbc:StartDate'),
        "MOTIVO": getValue(shipment, 'cbc:HandlingInstructions'),
        "DESTINATARIO": getValue(da, 'cac:DeliveryCustomerParty.cac:Party.cac:PartyLegalEntity.cbc:RegistrationName'),
        "PARTIDA": getValue(delivery, 'cac:Despatch.cac:DespatchAddress.cac:AddressLine.cbc:Line'),
        "LLEGADA": getValue(delivery, 'cac:DeliveryAddress.cac:AddressLine.cbc:Line'),
        "MODALIDAD": getValue(stage, 'cbc:TransportModeCode') === '01' ? 'Público' : 'Privado',
        "TRANSPORTISTA": transportistaNombre,
        "VEHICULO": getValue(equipment, 'cbc:ID'),
        "CONDUCTOR": transportistaNombre || getValue(stage, 'cac:DriverPerson.cac:IdentityDocumentReference.cbc:ID'),
        "PESO": getValue(shipment, 'cbc:GrossWeightMeasure'),
        "OBSERVACIONES": getValue(da, 'cbc:Note')
    };
}

// ===== Folder Picker - Client-Side Processing =====
let selectedFiles = null;

document.getElementById('btnSelectFolder').addEventListener('click', () => {
    document.getElementById('folderPicker').click();
});

document.getElementById('folderPicker').addEventListener('change', (e) => {
    selectedFiles = e.target.files;
    if (selectedFiles.length > 0) {
        const folderName = selectedFiles[0].webkitRelativePath.split('/')[0];
        document.getElementById('folderPath').value = `📂 ${folderName} (${selectedFiles.length} archivos)`;
        updateStatus(`Carpeta seleccionada: ${selectedFiles.length} archivos. Presiona "Iniciar Auditoría".`, 'blue');
    }
});

// ===== Process Button =====
document.getElementById('btnProcess').addEventListener('click', async () => {
    if (selectedFiles && selectedFiles.length > 0) {
        await processFilesClientSide(selectedFiles);
    } else {
        await processViaServer();
    }
});

async function processFilesClientSide(files) {
    showLoader(true);
    updateStatus('Procesando archivos en el navegador...', 'blue');

    try {
        const resultados = [];
        const xmlFiles = Array.from(files).filter(f => f.name.endsWith('.xml'));

        for (let i = 0; i < xmlFiles.length; i++) {
            try {
                const content = await xmlFiles[i].text();
                const info = extractorXMLBrowser(content);
                const match = xmlFiles[i].name.match(/(\w{4}-\d+)\.xml$/i);
                info["NRO DE SERIE Y GUIA"] = match ? match[1].toUpperCase() : xmlFiles[i].name;
                info["ORIGEN DATA"] = "XML";
                resultados.push(info);
            } catch (e) {
                console.error(`Error procesando ${xmlFiles[i].name}:`, e.message);
            }

            if (i % 50 === 0) updateStatus(`Procesando... ${i}/${xmlFiles.length} archivos`, 'blue');
        }

        resultados.sort((a, b) => (a["NRO DE SERIE Y GUIA"] || '').localeCompare(b["NRO DE SERIE Y GUIA"] || ''));

        lastResults = resultados;
        renderResults(lastResults);
        updateStats({ count: resultados.length, resultados });
        updateCharts(lastResults);
        updateStatus(`✅ Procesado con éxito: ${resultados.length} guías (Modo Navegador)`, 'green');
        syncScrollbars();
    } catch (error) {
        updateStatus(`Error: ${error.message}`, 'red');
        alert(error.message);
    } finally {
        showLoader(false);
    }
}

async function processViaServer() {
    const folderPath = document.getElementById('folderPath').value;
    if (!folderPath) return alert('Por favor ingresa una ruta o selecciona una carpeta con 📂.');

    showLoader(true);
    updateStatus('Procesando archivos...', 'blue');

    try {
        const response = await fetch('/api/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rutaCarpeta: folderPath })
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error);

        lastResults = data.resultados;
        renderResults(lastResults);
        updateStats(data);
        updateCharts(lastResults);

        let statusMsg = `Procesado con éxito: ${data.count} guías`;
        if (data.isDemo) statusMsg = `✨ ${data.message}`;
        updateStatus(statusMsg, data.isDemo ? 'orange' : 'green');

        syncScrollbars();

    } catch (error) {
        updateStatus(`Error: ${error.message}`, 'red');
        alert(error.message);
    } finally {
        showLoader(false);
    }
}

// CSV Export
document.getElementById('btnDownload').addEventListener('click', () => {
    const table = document.getElementById('resultsTable');
    if (!table || table.rows.length <= 1) return alert('No hay datos para exportar.');

    let csvContent = "\uFEFF";
    const rows = table.querySelectorAll('tr');

    rows.forEach(row => {
        const cols = row.querySelectorAll('td, th');
        const rowData = Array.from(cols).map(col => {
            let text = col.getAttribute('title') || col.innerText;
            return `"${text.replace(/"/g, '""')}"`;
        }).join(",");
        csvContent += rowData + "\r\n";
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", "Reporte_SUNAT_Master_Web.csv");
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

// Sorting Logic
document.querySelectorAll('th').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.innerText.trim();
        const map = {
            "GUÍA": "NRO DE SERIE Y GUIA",
            "FECHA": "FECHA EMISION",
            "MOTIVO": "MOTIVO",
            "DESTINATARIO": "DESTINATARIO",
            "PARTIDA": "PARTIDA",
            "LLEGADA": "LLEGADA",
            "TRANSPORTISTA": "TRANSPORTISTA",
            "VEHÍCULO": "VEHICULO",
            "PESO": "PESO",
            "ORIGEN": "ORIGEN DATA"
        };

        const internalKey = map[key] || key;

        if (sortConfig.key === internalKey) {
            sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
        } else {
            sortConfig.key = internalKey;
            sortConfig.direction = 'asc';
        }

        // Visual feedback
        document.querySelectorAll('th').forEach(h => h.className = '');
        th.className = sortConfig.direction === 'asc' ? 'sort-asc' : 'sort-desc';

        sortAndRender();
    });
});

function sortAndRender() {
    const sorted = [...lastResults].sort((a, b) => {
        let valA = a[sortConfig.key] || '';
        let valB = b[sortConfig.key] || '';

        if (sortConfig.key === 'PESO') {
            valA = parseFloat(valA) || 0;
            valB = parseFloat(valB) || 0;
        }

        if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
    });

    renderResults(sorted);
}

// Dual Scrollbar Sync
function syncScrollbars() {
    const top = document.getElementById('topScrollContainer');
    const bottom = document.getElementById('tableScrollContainer');
    const table = document.getElementById('resultsTable');
    const inner = document.getElementById('topScrollInner');

    inner.style.width = table.scrollWidth + 'px';
    top.style.opacity = table.scrollWidth > bottom.clientWidth ? '1' : '0';

    top.onscroll = () => { bottom.scrollLeft = top.scrollLeft; };
    bottom.onscroll = () => { top.scrollLeft = bottom.scrollLeft; };
}

function showLoader(show) {
    document.getElementById('loader').classList.toggle('hidden', !show);
}

function updateStatus(text, color) {
    const status = document.getElementById('statusText');
    status.innerText = text;
    status.style.color = color === 'green' ? 'var(--accent-blue)' : (color === 'red' ? 'var(--accent-pink)' : 'white');
}

function updateStats(data) {
    document.getElementById('statCount').innerText = data.count;

    let totalPeso = 0;
    data.resultados.forEach(r => {
        const p = parseFloat(r["PESO"]);
        if (!isNaN(p)) totalPeso += p;
    });
    document.getElementById('statWeight').innerText = `${totalPeso.toLocaleString()} KGM`;
}

function renderResults(resultados) {
    const tbody = document.querySelector('#resultsTable tbody');
    tbody.innerHTML = '';

    resultados.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${r["NRO DE SERIE Y GUIA"]}</td>
            <td>${r["FECHA EMISION"] || ''}</td>
            <td>${r["MOTIVO"] || ''}</td>
            <td title="${r["DESTINATARIO"]}">${(r["DESTINATARIO"] || '').substring(0, 20)}...</td>
            <td title="${r["PARTIDA"]}">${(r["PARTIDA"] || '').substring(0, 20)}...</td>
            <td title="${r["LLEGADA"]}">${(r["LLEGADA"] || '').substring(0, 20)}...</td>
            <td title="${r["TRANSPORTISTA"]}">${(r["TRANSPORTISTA"] || '').substring(0, 20)}${(r["TRANSPORTISTA"] || '').length > 20 ? '...' : ''}</td>
            <td>${r["VEHICULO"] || ''}</td>
            <td>${r["PESO"] || ''}</td>
            <td><span class="badge ${r["ORIGEN DATA"].toLowerCase()}">${r["ORIGEN DATA"]}</span></td>
        `;
        tbody.appendChild(tr);
    });
}

function updateCharts(resultados) {
    // ...
    const motivos = {};
    const distritos = {};

    resultados.forEach(r => {
        const m = r["MOTIVO"] || "No especificado";
        motivos[m] = (motivos[m] || 0) + 1;

        const llegada = r["LLEGADA"] || "";
        const parts = llegada.split(' - ');
        const dist = parts.length > 1 ? parts[parts.length - 1] : "Otros";
        distritos[dist] = (distritos[dist] || 0) + 1;
    });

    renderMotivoChart(motivos);
    renderDestinoChart(distritos);
}

function renderMotivoChart(dataMap) {
    const ctx = document.getElementById('motivoChart').getContext('2d');
    if (motivoChart) motivoChart.destroy();

    motivoChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: Object.keys(dataMap),
            datasets: [{
                data: Object.values(dataMap),
                backgroundColor: ['#ff007a', '#00d2ff', '#ff8a00', '#7b2ff7', '#adff00'],
                borderWidth: 0
            }]
        },
        options: {
            plugins: { legend: { position: 'bottom', labels: { color: '#a0a0b8' } } }
        }
    });
}

function renderDestinoChart(dataMap) {
    const ctx = document.getElementById('destinoChart').getContext('2d');
    if (destinoChart) destinoChart.destroy();

    const sorted = Object.entries(dataMap).sort((a, b) => b[1] - a[1]).slice(0, 5);

    destinoChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: sorted.map(s => s[0]),
            datasets: [{
                label: 'Guías',
                data: sorted.map(s => s[1]),
                backgroundColor: 'rgba(0, 210, 255, 0.5)',
                borderColor: '#00d2ff',
                borderWidth: 1
            }]
        },
        options: {
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#a0a0b8' } },
                x: { ticks: { color: '#a0a0b8' } }
            },
            plugins: { legend: { display: false } }
        }
    });
}
