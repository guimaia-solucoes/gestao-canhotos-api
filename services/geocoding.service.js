const https = require('https');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function buscarLatLong(endereco, numero, bairro, cidade, estado) {
  if (!endereco || !cidade || !estado) return { latitude: null, longitude: null };

  const estadoExtenso = estadoPorSigla(estado);

  // Tentativa 1: Nominatim com endereço completo com número
  let resultado = await _tentarNominatim(endereco, numero, bairro, cidade, estadoExtenso);
  if (resultado.latitude) return resultado;

  // Tentativa 2: Google Maps com endereço completo
  resultado = await _tentarGoogleMaps(endereco, numero, cidade, estadoExtenso);
  if (resultado.latitude) return resultado;

  // Tentativa 3: Nominatim sem número e sem bairro
  resultado = await _tentarNominatim(endereco, null, null, cidade, estadoExtenso);
  if (resultado.latitude) return resultado;

  return { latitude: null, longitude: null };
}

async function _tentarNominatim(endereco, numero, bairro, cidade, estado) {
  const street = numero ? `${endereco}, ${numero}` : endereco;

  const params = new URLSearchParams({
    format: 'jsonv2',
    street: street,
    ...(bairro && { suburb: bairro }),
    city: cidade,
    state: estado,
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
            resolve({ latitude: parseFloat(melhor.lat), longitude: parseFloat(melhor.lon) });
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

async function _tentarGoogleMaps(endereco, numero, cidade, estado) {
  const apiKey = process.env.GOOGLE_MAPS_KEY;
  if (!apiKey) return { latitude: null, longitude: null };

  const address = `${endereco}, ${numero || ''}, ${cidade}, ${estado}, Brasil`.trim();
  const params = new URLSearchParams({
    address: address,
    key: apiKey,
    region: 'br',
    language: 'pt-BR',
  });

  const url = `/maps/api/geocode/json?${params.toString()}`;

  return new Promise((resolve) => {
    const options = {
      hostname: 'maps.googleapis.com',
      path: url,
      method: 'GET',
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'OK' && json.results.length > 0) {
            const loc = json.results[0].geometry.location;
            console.log(`[Google Maps] Encontrado: ${address} → ${loc.lat}, ${loc.lng}`);
            resolve({ latitude: loc.lat, longitude: loc.lng });
          } else {
            console.log(`[Google Maps] Não encontrado: ${address} | status: ${json.status}`);
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
  await sleep(1100); // respeita limite do Nominatim
  return resultado;
}

module.exports = { buscarLatLong, buscarLatLongComDelay };