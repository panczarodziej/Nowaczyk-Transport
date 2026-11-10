# Nowaczyk Transport — wspólny system 0.3.2

Ta paczka zawiera serwer strony, panele, źródła aplikacji Windows, DLL telemetrii,
wbudowany importer zapisów i konfigurację budowania instalatora. To aktualizacja
źródeł istniejącego systemu, a nie gotowy, sprawdzony w ETS2 instalator EXE.

## GitHub i Render

Projekt jest przeznaczony dla osobnego repozytorium `panczarodziej/Nowaczyk-Transport`.
Pliki `server.js`, `render.yaml` i katalog `.github` powinny być w jego katalogu głównym.
Na Render wybierz **New → Blueprint** i wskaż nowe repozytorium oraz gałąź `main`.

- `ADMIN_PASSWORD` — hasło startowe konta `admin`, minimum 12 znaków.
- `DATABASE_URL` — adres osobnej bazy PostgreSQL dla Nowaczyk Transport. Schemat
  tworzy się przy starcie. Użyj jednej instancji serwera. Lokalny JSON na
  efemerycznym dysku Render może zniknąć przy ponownym wdrożeniu.
- `TELEMETRY_DOWNLOAD_URL` — po publikacji wydania ustaw bezpośredni adres HTTPS
  do EXE, dostępny dla kierowców. W prywatnym repozytorium plik wydania wymaga
  dostępu do repozytorium. Strona udostępnia link na `/telemetry.html`.

Po wdrożeniu użyj faktycznego adresu HTTPS przydzielonego przez Render
w ustawieniach aplikacji Windows. Domyślna wartość zakłada adres
`https://nowaczyk-transport.onrender.com`.

## Instalator aplikacji

Push do `main` uruchamia testy i kompilację Windows. Instalator jest publikowany
w GitHub Releases i dostępny w zakładce **Telemetria** panelu kierowcy.
Kopię instalatora z danego buildu znajdziesz też w artefaktach GitHub Actions.

Lokalnie na Windows w katalogu `telemetry-app` uruchom `npm ci`, a następnie
`npm run build:win`. Wynik znajdziesz w `telemetry-app/dist`.

## Pierwsze uruchomienie kierowcy

1. Zainstaluj nowy EXE. Wskaż folder ETS2, np.
   D:\SteamLibrary\steamapps\common\Euro Truck Simulator 2.
2. Przy wyłączonej grze zapisz ustawienia. Aplikacja doinstaluje brakujący plugin.
   Ręczne ponowne zainstalowanie pluginu tworzy kopię istniejącej DLL. Uruchom ETS2 i zaakceptuj komunikat SDK.
3. W aplikacji otwórz panel i zaloguj się tym samym kontem, co na stronie.
4. Włącz automatyczną synchronizację i zapisz ustawienia. Uruchom jazdę.
5. Na stronie w Tachografie sprawdź prędkość, towar i masę. „Offline” oznacza
   brak aktualizacji od ponad 45 sekund. Postój nie oznacza automatycznie pauzy.

## Dodanie oferty do gry z aplikacji

Importer nie wymaga uruchamiania osobnego Virtual Speditora. Zmienia istniejącą
ofertę rynku ładunków w zapisie, a nie aktywny kontrakt podczas jazdy.

1. W zleceniu wpisz identyfikatory firm, miast i towaru zgodne z aktywną mapą,
   np. transinet, krakow, tradeaux, berlin. Polskie nazwy handlowe nie muszą być
   identyfikatorami gry. Importer odrzuca niejednoznaczne lub nieznane wpisy.
2. W pliku config.cfg profilu gry ustaw `uset g_save_format "2"`.
   Zapisz grę i wróć do menu wyboru profili. Nie kontynuuj jazdy w trakcie importu.
3. Aplikacja → Pobierz moje zlecenia → Dodaj ofertę do zapisu ETS2.
4. Wskaż game.sii tego zapisu. Importer przed zmianą tworzy dokładną kopię .bak.
5. Wczytaj zmieniony zapis w ETS2. Odbierz towar w firmie na rynku ładunków.

Istotne ograniczenia: importer wymaga istniejącej oferty tego samego towaru
w firmie załadunku. Zachowuje naczepę i units_count tej oferty; nie ustawia
arbitralnej masy. Przy braku szablonu przerywa, zamiast wpisywać niezgodne dane.
Nie dekoduje binarnych zapisów i nie obsługuje zleceń World of Trucks.
Nie potwierdzono jeszcze zgodności na rzeczywistym zapisie ETS2 1.60.

Wariant ProMods / ProMods + PR zapisuje się na koncie. Mapy aktywujesz w grze;
importer korzysta z firm istniejących w wybranym zapisie. Nie instaluje map.

## Załadunek, dostawa i pieniądze

Czytnik przesyła stan cargoLoaded, onJob, masę i zdarzenia job-started /
job-delivered. Panel wyświetla te dane z serwera. Zgodność zlecenia wymaga obu
miast, obu firm, towaru i masy (tolerancja 50 kg). Przy rozładunku zachowywana
jest ostatnia informacja o ładunku, nawet jeśli gra wyczyści pola kontraktu.

Zdarzenia nie uruchamiają automatycznych płatności. Ten mechanizm pozostaje
wyłączony: poprawka nie dodaje pełnego bezpiecznego rozliczania po dostawie,
nie potwierdza kompletności ekonomii i nie udaje, że sam import oznacza kurs.
Przy braku kompletnej zgodności wydarzenie pozostaje widoczne jako niezgodne.

## Co sprawdzono

Przejście HTTP: logowanie, konto kierowcy, przydzielenie trasy, eksport zagnieżdżony,
przesłanie masy i aktywności, odczyt w panelu, blokada widoku innych kierowców,
wykrycie błędnej masy, deduplikacja zdarzeń i równoległe zapisy w jednym procesie.
Importer: zmiana właściwej oferty, zachowanie naczepy, odrzucanie braków, kopia
zapasowa i brak modyfikacji przy błędzie. To nie zastępuje sprawdzenia w grze.
Uruchomienie kontroli: `npm test`.

Zapis serwera jest serializowany w jednym procesie. Nie uruchamiaj kilku instancji
backendu na tej samej bazie — magazyn JSON w PostgreSQL nie obsługuje jeszcze
transakcyjnych zmian z wielu instancji.

Źródła formatu: https://forum.scssoft.com/viewtopic.php?start=2330&t=199114
Układ pamięci: https://github.com/RenCloud/scs-sdk-plugin/blob/V.1.12.1/scs-client/C%23/SCSSdkClient/SCSSdkConvert.cs
Licencja pluginu znajduje się obok DLL.

## Przyjęcie trasy wyłącznie w aplikacji (0.3.1)

Spedytor tworzy trasę na /trasy.html. Status „Przydzielona” oznacza oczekiwanie
na kierowcę. Kierowca widzi ją również na stronie, ale przyjęcie wykonuje
przyciskiem „Przyjmij trasę” w aplikacji. Aplikacja odświeża listę co 15 sekund
po zalogowaniu natywnym formularzem.

W aplikacji użyj formularza „Zaloguj aplikację” — login i hasło są takie same
jak na stronie. Po restarcie aplikacji zaloguj ją ponownie. Hasło nie jest
zapisywane na dysku. Samo logowanie w otwartym oknie strony nie uprawnia do
przyjmowania tras. Serwer wymaga osobnej sesji aplikacji i losowego tokenu.
Token nie jest zwracany przez zwykły endpoint informacji o koncie.
Jest to rozdzielenie kanałów klienta, a nie atestacja oryginalności programu.

Po przyjęciu na serwerze zapisują się acceptedAt, acceptedBy, acceptedVia=desktop
oraz status „Przyjęta”. Ponowne kliknięcie tej samej trasy nie duplikuje przyjęcia.
Nie można przyjąć cudzej trasy. Można przyjąć kilka kolejnych zleceń do swojej kolejki. Przyjęcie nie tworzy automatycznie kontraktu w ETS2
ani nie księguje pieniędzy. Przycisk importera odblokowuje się po przyjęciu.
Ograniczenia importera i wyłączonych automatycznych rozliczeń opisane wyżej
pozostają aktualne. Pełnego zamknięcia trasy nie dodano w tej poprawce.

Naprawa blokady centrum operacyjnego: po otwarciu panel odczytuje konto
z /api/accounts/me i odtwarza rolę w interfejsie. Brak starego wpisu w pamięci
przeglądarki nie blokuje już zalogowanego administratora. Nie zmieniono lokalnych
rejestrów starego centrum operacyjnego w dane online; do przydziału używaj
„Trasy online”, a nie starych demonstracyjnych tabel.

