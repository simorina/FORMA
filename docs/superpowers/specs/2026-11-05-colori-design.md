# Colori del modello AI fino a Bambu Studio

## Perché

Pixal3D (e TRELLIS.2, il suo fallback) restituiscono un GLB con una texture di colore da
1024 px. Forma la scarta al caricamento (`load_mesh_file`, "Strip visuals"), quindi vista 3D,
export e slicer vedono un modello monocolore. L'utente stampa su una **Bambu Lab con AMS** e
prepara la stampa in **Bambu Studio**: vuole che i colori originali arrivino nello slicer e si
possano stampare abbinandoli ai filamenti caricati.

## Obiettivi

1. I colori della texture diventano **colori per vertice** al caricamento e sopravvivono a tutta
   la preparazione: riparazione, orientamento, scala, fondo piano, svuotamento, base,
   semplificazione, e alla modifica a mano ("Ripara e aggiorna").
2. La **vista 3D** mostra il modello con i suoi colori.
3. **Export OBJ con colori per vertice** (`v x y z r g b`, valori 0–1, millimetri): Bambu Studio
   (≥ 1.10) all'import apre la finestra in cui si sceglie il numero di colori e lo slot AMS di
   ciascuno. **Export GLB** con i colori (attributo `COLOR_0`).
4. **Miniature** della cronologia con i colori.
5. Anche una mesh colorata **caricata a mano** (GLB, OBJ o PLY con colori) li mantiene.
6. Un modello **senza colori** si comporta esattamente come oggi.

## Non obiettivi

- Ridurre a N colori o abbinare gli slot AMS dentro Forma: lo fa Bambu Studio all'import.
- Colori nel 3MF (le versioni di Bambu Studio non recentissime scartano i colori dei 3MF che non
  ha scritto lui) e nello STL (il formato non li prevede): restano monocolore.
- Recuperare i colori dei modelli già generati: la loro sorgente salvata non li ha. Vanno
  rigenerati.
- Pittura dei colori nell'editor.
- Colori per le forme procedurali (modalità Offline).

## Anti-obiettivi

- Rallentare la preparazione di un modello da 1 milione di triangoli di più di ~2 s.
- Cambiare il comportamento dei modelli senza colori (forme, report, export, test esistenti).

## Vincoli

- L'utente ha scelto: stampante Bambu Lab con AMS, slicer Bambu Studio.
- I file dell'utente non ancora committati (`providers/endpoints/*`, `tests/test_api.py`,
  `.env.example`) non si toccano.
- I modelli arrivano fino a ~1 M triangoli (qualità Alta): ogni passo sui colori deve essere
  vettoriale (numpy / scipy), niente cicli Python per vertice.

## Come (decisioni prese da me, l'utente può cambiarle)

- **Colori per vertice, non per faccia.** La mesh resta saldata e chiusa (stampabile), la vista
  e l'OBJ li leggono direttamente, e a 1 M triangoli la granularità è molto più fine del
  filamento.
- **OBJ come formato "a colori".** L'OBJ con `v x y z r g b` è letto dal parser di Bambu Studio
  (verificato nel sorgente: `objparser.cpp`, `OBJ.cpp`). Il 3MF resta il formato consigliato per i
  modelli monocolore; per un modello con colori l'interfaccia consiglia l'OBJ.
- **Trasporto dei colori nella pipeline per vertice più vicino.** Rotazioni, scala e spostamenti
  di trimesh mantengono già i colori. Solo i passi che ricostruiscono la mesh (riparazione
  manifold3d / pymeshlab / voxel, semplificazione, fondo piano, svuotamento, base) li perdono:
  dopo ciascuno, ogni nuovo vertice prende il colore del vertice più vicino della mesh di prima
  del passo (stesso sistema di riferimento; KD-tree). Le facce nuove (base, cavità, tappo del
  fondo piano) prendono così il colore della parte di modello più vicina.
- **Modifica a mano.** L'editor continua a inviare un STL; il backend, quando il file è la
  modifica di un modello (`model_id` presente), ricolora la mesh modificata dal modello di
  partenza per vertice più vicino.
- **Vista 3D.** Se il GLB ha `COLOR_0`, il materiale del modello usa i colori per vertice con
  colore base bianco; il filamento continua a guidare i colori di sbalzi, sezione e reticolo.
  Durante la modifica a mano i colori restano visibili (la saldatura dell'editor rimappa anche
  l'attributo colore).
- **API.** Ogni modello espone `has_colors: bool`, che il frontend usa per la vista e per il
  consiglio sul formato.

## Lasciato a chi costruisce

- Conversione della texture: `TextureVisuals.to_color()` di trimesh (0,1 s su un GLB di Pixal3D);
  altri casi (colori per faccia, materiali senza texture col solo colore base) a scelta, purché il
  risultato sia per vertice o assente.
- Mesh concatenate con parti colorate e parti no: le parti senza colore prendono un grigio neutro.
- Testo e posizione del consiglio "Con i colori: OBJ" nel pannello di esportazione, nello stile
  Atelier esistente.
- Ombreggiatura delle miniature: colore per vertice mediato sulla faccia, moltiplicato per la
  luce attuale.

## Verifica

- Test backend: GLB con texture → mesh con colori; `process_mesh` mantiene i colori attraverso
  riparazione, svuotamento, base e semplificazione (e un modello senza colori resta senza);
  l'OBJ esportato ha righe `v` con 6 valori; il GLB ha i colori; una modifica caricata con
  `model_id` torna colorata; `has_colors` nelle risposte API.
- Test frontend: la saldatura dell'editor conserva i colori.
- Su un GLB vero di Pixal3D: pipeline completa, tempo aggiuntivo misurato, OBJ esportato.
- L'import in Bambu Studio lo verifica l'utente (non è installabile qui): numero di colori,
  abbinamento agli slot AMS, aspetto dei colori.

## Rischi

- Bambu Studio può applicare una correzione gamma ai colori degli OBJ (`gamma_correct` nel
  loader): i colori nello slicer potrebbero apparire leggermente diversi. Si abbinano comunque ai
  filamenti veri.
- OBJ grandi: a 1 M triangoli circa 100 MB con i colori. La finestra di import di Bambu Studio
  con ~30.000 colori distinti e 1 M triangoli non è stata provata.
