const pdf = require('pdf-parse');
const { XMLParser } = require('fast-xml-parser');

const ALL_LABELS = [
    { key: "EMISION", labels: ["Fecha y hora de emisión", "Fecha de emisión", "Fecha Emisión"] },
    { key: "ENTREGA", labels: ["Fecha de entrega de Bienes al transportista", "Fecha de inicio de Traslado", "Fecha inicio de traslado"] },
    { key: "MOTIVO", labels: ["Motivo de Traslado", "Motivo de traslado"] },
    { key: "DESTINATARIO", labels: ["Datos del Destinatario", "Destinatario"] },
    { key: "PARTIDA", labels: ["Punto de Partida", "Punto de partida"] },
    { key: "LLEGADA", labels: ["Punto de llegada", "Punto de llegada"] },
    { key: "MODALIDAD", labels: ["Modalidad de Traslado", "Modalidad de traslado"] },
    { key: "TRANSPORTISTA", labels: ["Datos del transportista", "Transportista"] },
    { key: "VEHICULO", labels: ["Datos de los vehículos", "Número de placa", "Vehículo", "Placa"] },
    { key: "CONDUCTOR", labels: ["Datos de los conductores", "Conductor"] },
    { key: "PESO", labels: ["Peso Bruto total de la carga", "Peso Bruto"] },
    { key: "OBSERVACIONES", labels: ["Observaciones"] }
];

function extractorSunat(texto) {
    const lines = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const labelIndices = [];

    ALL_LABELS.forEach(entry => {
        entry.labels.forEach(label => {
            lines.forEach((line, idx) => {
                if (line.toLowerCase().includes(label.toLowerCase())) {
                    labelIndices.push({ key: entry.key, label, idx, original: line });
                }
            });
        });
    });

    labelIndices.sort((a, b) => a.idx - b.idx);

    const getVal = (key) => {
        const entries = labelIndices.filter(l => l.key === key);
        if (entries.length === 0) return 'No encontrado';

        for (const entry of entries) {
            const afterLabel = entry.original.split(/:\s*/)[1];
            if (afterLabel && afterLabel.length > 2 && !ALL_LABELS.some(al => al.labels.some(lbl => afterLabel.includes(lbl)))) {
                return afterLabel.trim();
            }

            const nextLabel = labelIndices.find(l => l.idx > entry.idx);
            const endIdx = nextLabel ? nextLabel.idx : lines.length;

            for (let i = entry.idx + 1; i < endIdx; i++) {
                if (lines[i].length > 2) return lines[i];
            }

            for (let i = 1; i <= 3; i++) {
                let prevIdx = entry.idx - i;
                if (prevIdx >= 0 && lines[prevIdx] && lines[prevIdx].length > 5 && !ALL_LABELS.some(al => al.labels.some(lbl => lines[prevIdx].includes(lbl)))) {
                    if (key === "PARTIDA" || key === "LLEGADA") {
                        if (/JR\.|AV\.|URB\.|CALLE|LIMA|SURCO|BARRANCO|MZA\.|LOTE\./i.test(lines[prevIdx])) return lines[prevIdx];
                    } else if (key === "EMISION" && /\d{2}\/\d{2}\/\d{4}/.test(lines[prevIdx])) {
                        return lines[prevIdx];
                    } else {
                        return lines[prevIdx];
                    }
                }
            }
        }
        return '';
    };

    return {
        "FECHA EMISION": getVal("EMISION"),
        "FECHA ENTREGA/TRASLADO": getVal("ENTREGA"),
        "MOTIVO": getVal("MOTIVO"),
        "DESTINATARIO": getVal("DESTINATARIO"),
        "PARTIDA": getVal("PARTIDA"),
        "LLEGADA": getVal("LLEGADA"),
        "MODALIDAD": getVal("MODALIDAD"),
        "TRANSPORTISTA": getVal("TRANSPORTISTA"),
        "VEHICULO": getVal("VEHICULO"),
        "CONDUCTOR": getVal("CONDUCTOR"),
        "PESO": getVal("PESO"),
        "OBSERVACIONES": getVal("OBSERVACIONES")
    };
}

function extractorXML(xmlContent) {
    const parser = new XMLParser({ ignoreAttributes: false });
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

    // Extracción de Placa: Seguir ruta exacta de la imagen y fallbacks
    let equipment = getSafe(shipment, 'cac:TransportHandlingUnit.cac:TransportEquipment');
    if (!getValue(equipment, 'cbc:ID')) {
        equipment = getSafe(shipment, 'cac:TransportEquipment');
    }

    // Conductor / Transportista desde DriverPerson
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

module.exports = { extractorSunat, extractorXML, ALL_LABELS };
