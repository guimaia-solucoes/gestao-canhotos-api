const https = require('https');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Em geocoding.service.js, remova o fallback e retorne null
async function buscarLatLong(endereco, numero, bairro, cidade, estado) {
  if (!endereco || !cidade || !estado) {
    return { latitude: null, longitude: null };
  }

  const street = numero ? `${endereco}, ${numero}` : endereco;
  const estadoExtenso = estadoPorSigla(estado);

  const params = new URLSearchParams({
    format: 'jsonv2',
    street: street,
    ...(bairro && { suburb: bairro }),
    city: cidade,
    state: estadoExtenso,
    country: 'Brasil',
    countrycodes: 'br',
    addressdetails: '1',
    limit: '5',
  });

  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;

  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'gestao-canhotos/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.length > 0) {
            const melhor = json.sort((a, b) => b.importance - a.importance)[0];
            resolve({
              latitude: parseFloat(melhor.lat),
              longitude: parseFloat(melhor.lon),
            });
          } else {
            // ✅ Não usa fallback — retorna null se não encontrou
            resolve({ latitude: null, longitude: null });
          }
        } catch {
          resolve({ latitude: null, longitude: null });
        }
      });
    }).on('error', () => resolve({ latitude: null, longitude: null }));
  });
}

// Fallback: busca só pela cidade quando o endereço não encontra resultado
async function buscarLatLongCidade(cidade, estado) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    city: cidade,
    state: estado,
    country: 'Brasil',
    countrycodes: 'br',
    limit: '1',
  });

  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;

  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'gestao-canhotos/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.length > 0) {
            resolve({
              latitude: parseFloat(json[0].lat),
              longitude: parseFloat(json[0].lon),
            });
          } else {
            resolve({ latitude: null, longitude: null });
          }
        } catch {
          resolve({ latitude: null, longitude: null });
        }
      });
    }).on('error', () => resolve({ latitude: null, longitude: null }));
  });
}

// Converte sigla para nome completo do estado
function estadoPorSigla(sigla) {
  const estados = {
    AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas',
    BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo',
    GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul',
    MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
    PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
    RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina',
    SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
  };
  return estados[sigla?.toUpperCase()] || sigla;
}

async function buscarLatLongComDelay(endereco, numero, bairro, cidade, estado) {
  const resultado = await buscarLatLong(endereco, numero, bairro, cidade, estado);
  await sleep(1100);
  return resultado;
}

module.exports = { buscarLatLong, buscarLatLongComDelay };