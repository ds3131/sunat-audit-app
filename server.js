const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const pdf = require('pdf-parse');
const { Parser } = require('json2csv');
const { extractorSunat, extractorXML } = require('./lib/extractor');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.post('/api/process', async (req, res) => {
    const { rutaCarpeta } = req.body;
    const isVercel = process.env.VERCEL === '1' || !rutaCarpeta;

    // --- MODO SHOWCASE (Demo) ---
    if (isVercel || !await fs.pathExists(rutaCarpeta)) {
        console.log("Activando Modo Showcase (Demo)");
        const mockResultados = [
            { "NRO DE SERIE Y GUIA": "EG07-1000", "FECHA EMISION": "2026-02-15 10:30", "MOTIVO": "Venta", "DESTINATARIO": "CLIENTE DEMO 1 S.A.C.", "PARTIDA": "LIMA", "LLEGADA": "BARRANCO", "TRANSPORTISTA": "JUAN PEREZ", "VEHICULO": "ABC-123", "PESO": 1250.50, "ORIGEN DATA": "XML" },
            { "NRO DE SERIE Y GUIA": "EG07-1001", "FECHA EMISION": "2026-02-15 11:45", "MOTIVO": "Traslado entre establecimientos", "DESTINATARIO": "F Y D INVERSIONES S.A.C.", "PARTIDA": "LURIN", "LLEGADA": "LIMA", "TRANSPORTISTA": "CARLOS ROSAS", "VEHICULO": "XYZ-987", "PESO": 840.00, "ORIGEN DATA": "XML" },
            { "NRO DE SERIE Y GUIA": "EG07-1002", "FECHA EMISION": "2026-02-16 09:15", "MOTIVO": "Venta", "DESTINATARIO": "LOGISTICA NORTE E.I.R.L.", "PARTIDA": "CALLAO", "LLEGADA": "COMAS", "TRANSPORTISTA": "MARCO RUIZ", "VEHICULO": "PLK-456", "PESO": 3200.75, "ORIGEN DATA": "PDF" },
            { "NRO DE SERIE Y GUIA": "EG07-1003", "FECHA EMISION": "2026-02-16 14:20", "MOTIVO": "Venta", "DESTINATARIO": "TIENDAS RETAIL S.A.", "PARTIDA": "LIMA", "LLEGADA": "MIRAFLORES", "TRANSPORTISTA": "LUIS AMAYA", "VEHICULO": "GHT-112", "PESO": 450.20, "ORIGEN DATA": "XML" },
            { "NRO DE SERIE Y GUIA": "EG07-1004", "FECHA EMISION": "2026-02-17 08:00", "MOTIVO": "Compra", "DESTINATARIO": "PROVEEDOR TEXTIL PERU", "PARTIDA": "ATE", "LLEGADA": "LURIN", "TRANSPORTISTA": "PEDRO GOMEZ", "VEHICULO": "MNB-334", "PESO": 150.00, "ORIGEN DATA": "XML" }
        ];

        return res.json({
            count: mockResultados.length,
            resultados: mockResultados,
            isDemo: true,
            message: isVercel ? 'Modo Vitrina (Datos de Prueba)' : 'Ruta no encontrada. Mostrando datos de prueba.'
        });
    }

    try {
        const archivos = await fs.readdir(rutaCarpeta);
        const pdfs = archivos.filter(f => f.endsWith('.pdf'));
        const xmls = archivos.filter(f => f.endsWith('.xml'));
        const resultados = [];

        // ... rest of the extraction logic ...
        const xmlMap = new Map();
        for (const xmlFile of xmls) {
            const match = xmlFile.match(/(\w{4}-\d+)\.xml$/i);
            if (match) xmlMap.set(match[1].toUpperCase(), xmlFile);
        }

        const todasLasGuias = new Set();
        pdfs.forEach(f => {
            const m = f.match(/(EG07-\d+)/i);
            if (m) todasLasGuias.add(m[1].toUpperCase());
        });
        xmlMap.forEach((_, key) => todasLasGuias.add(key));

        const guiasArray = Array.from(todasLasGuias).sort();

        for (const guiaID of guiasArray) {
            let info = null;
            const xmlFile = xmlMap.get(guiaID);

            if (xmlFile) {
                try {
                    const xmlContent = await fs.readFile(path.join(rutaCarpeta, xmlFile), 'utf-8');
                    info = extractorXML(xmlContent);
                    info["NRO DE SERIE Y GUIA"] = guiaID;
                    info["ORIGEN DATA"] = "XML";
                } catch (e) {
                    console.error(`Error procesando XML ${xmlFile}:`, e.message);
                }
            }

            if (!info) {
                const pdfFile = pdfs.find(f => f.toUpperCase().includes(guiaID));
                if (pdfFile) {
                    try {
                        const dataBuffer = await fs.readFile(path.join(rutaCarpeta, pdfFile));
                        const data = await pdf(dataBuffer);
                        const extr = extractorSunat(data.text);
                        info = { "NRO DE SERIE Y GUIA": guiaID, ...extr, "ORIGEN DATA": "PDF" };
                    } catch (e) { }
                }
            }

            if (info) resultados.push(info);
        }

        res.json({
            count: resultados.length,
            resultados,
            csvPath: path.join(rutaCarpeta, 'Reporte_Detallado_EG07.csv')
        });

        // Guardar CSV de respaldo (Solo en local, no en Vercel)
        if (resultados.length > 0 && !process.env.VERCEL) {
            const json2csvParser = new Parser();
            const csv = json2csvParser.parse(resultados);
            await fs.writeFile(path.join(rutaCarpeta, 'Reporte_Detallado_EG07.csv'), csv);
        }

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor Auditor corriendo en http://localhost:${PORT}`);
});
