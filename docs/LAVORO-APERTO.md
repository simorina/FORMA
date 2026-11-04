# Lavoro aperto: cosa manca a Forma e come spendere 100 $

Questo documento è per chi prende in mano il progetto. Tutto il resto (pipeline di stampa,
interfaccia, modifica a mano, export, test) è fatto e verificato: 118 test pytest, 87 vitest,
24 flussi end-to-end (`make test`, `make e2e`). Qui c'è solo ciò che **non è stato possibile
verificare** nell'ambiente di sviluppo originale, in ordine di priorità.

## Prima di cominciare (10 minuti)

```bash
git clone https://github.com/EmanueleCavaliero/pjsr && cd pjsr
make install
make offline        # tutto senza rete: deve funzionare subito
make test && make e2e
```

Se questi passano, l'ambiente è a posto e si può lavorare sulle voci sotto.

## 1. Provare davvero gli Space di Hugging Face (priorità massima)

**Il problema.** L'ambiente originale bloccava huggingface.co: il provider predefinito
`hf_remote` (FLUX.1-schnell → Pixal3D, con fallback TRELLIS.2) è testato solo con un client
Gradio simulato. Non è mai stata fatta una generazione reale.

**Cosa fare.**
1. Account Hugging Face, token *Read*, in `.env`: `HF_TOKEN=hf_...`.
2. `make dev`, genera 5–10 oggetti diversi (vaso, pedone, razzo, una foto vera).
3. Per ogni errore guarda il log del backend. Se uno Space ha cambiato API (nomi degli endpoint,
   ordine dei parametri, formato della risposta) la correzione sta in **un solo file** di
   `backend/app/providers/endpoints/` (`pixal3d.py`, `trellis.py`, …). Aggiorna il test simulato
   corrispondente in `backend/tests/test_api.py` con la risposta vera.
4. Controlla anche: il fallback a TRELLIS.2 quando Pixal3D è giù, i messaggi di coda e quota, la
   traduzione IT→EN del prompt (con il token l'anteprima mostra "In inglese per il modello
   d'immagine").

**Costo.** HF PRO, 9 $/mese: circa 8 volte la quota ZeroGPU gratuita e priorità in coda. Oltre la
quota, minuti extra a 1 $ ogni 10 minuti (prezzi di novembre 2026: verifica su
huggingface.co/pricing). **Budget consigliato: 9–20 $.**

## 2. Provare il provider locale su GPU NVIDIA

**Il problema.** `backend/app/providers/local.py` (Pixal3D/TRELLIS.2 + FLUX in locale) e
`Dockerfile.gpu` non sono mai stati eseguiti: nell'ambiente originale non c'erano né GPU né
Docker.

**Cosa fare.** Noleggia una GPU a ore con almeno 24 GB di VRAM (per esempio una RTX 4090 o una
A100 da un servizio cloud a ore), poi:

```bash
make install-gpu    # oppure: make docker-gpu
GEN_PROVIDER=local make dev
```

La prima generazione scarica alcune decine di GB di pesi. Annota VRAM usata e tempi per qualità
(bozza, standard, alta) e scrivili nel README al posto delle stime: oggi il README non dà numeri
di VRAM proprio perché non sono stati misurati.

**Costo.** Qualche dollaro l'ora; 3–5 ore bastano. **Budget consigliato: 15–30 $.**
Spegni l'istanza quando hai finito.

## 3. Costruire le immagini Docker

`docker compose config` è validato, ma nessuna immagine è stata costruita. Su qualunque macchina
con Docker:

```bash
make docker         # CPU, http://localhost:8000
```

Verifica che `make docker` serva l'app e che una generazione offline
(`GEN_PROVIDER=procedural`) funzioni nel container. Costo: zero.

## 4. Pulizia del repository

- Cancella il branch remoto vecchio `feature/ai-3d-modeler` (non serve più).
- Il lavoro di sviluppo è su `claude/nifty-pascal-ohtxn8`, già unito in `main`.

## 5. Se avanza budget: miglioramenti con valore reale

In ordine di utilità per chi stampa:

1. **3MF con impostazioni di stampa** (altezza strato, riempimento, materiale) lette da Bambu
   Studio e PrusaSlicer, così lo slicer parte già configurato.
2. **Supporti visibili nell'anteprima**: oggi la mappa degli sbalzi dice *dove* servono; mostrare
   colonne di supporto stimate e il loro peso renderebbe la stima dei grammi più precisa.
3. **Divisione in parti** per oggetti più grandi del piatto, con incastri.
4. **Testo in rilievo** su una faccia (un nome sulla base del modello).
5. **Confronto tra modelli** (Pixal3D contro TRELLIS.2 sullo stesso prompt), da usare dopo la
   voce 1 per decidere il modello predefinito con dati veri.

## Ripartizione indicativa dei 100 $

| Voce | Budget |
| --- | --- |
| HF PRO + minuti extra per i test reali | 9–20 $ |
| GPU a ore per il provider locale | 15–30 $ |
| Margine per rifare test dopo le correzioni | 10–20 $ |
| Resto: miglioramenti della sezione 5 | il rimanente |

## Regole del progetto

- Interfaccia e README in italiano, codice e commenti in inglese.
- Deve funzionare **anche senza HF_TOKEN** (quota gratuita) e **offline** (`make offline`).
- Prima di ogni push: `make lint`, `make test`, `make e2e`; se cambi l'interfaccia, anche
  `make screenshots`.
- Non scrivere nel README numeri non misurati (tempi, VRAM, quote): meglio dire che mancano.
