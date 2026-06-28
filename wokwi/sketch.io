#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include "HX711.h"
#include <Preferences.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

//  ---- PINES LED---
#define LCD_SDA 21
#define LCD_SCL 22
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_ADDR 0x3C
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
// -----

// ---- Balanza
#define HX711_DT   17
#define HX711_SCK  16
HX711 balanza;
float FACTOR_CALIBRACION = 0.41875;

// --------- SIMULACION DE EXTRACCION
#define MODO_SIMULACION true   // true = simula extraccion; en hardware real va false
float pesoSimuladoKg   = 0.0;  // peso simulado (se usa recien tras configurar la descarga)
bool  descargaConfigurada = false; // si ya llego el comando config; activa el modo simulado
const float TASA_KG_S  = 0.05; // velocidad de extraccion (50 g/s)
bool  extrayendo       = false;
float gramosPorExtraer = 0.0;  // cantidad FIJA de gramos que falta extraer
unsigned long ultimoMs = 0;

// --------

// ---- WIFI
Preferences prefs;
WiFiClient   wifiClient;
// ----

// BOtones
#define PIN_BTN_TARA 19
#define PIN_BTN_WIFI 4
unsigned long ultimoTara = 0;
unsigned long ultimoWifi = 0;
const unsigned long DEBOUNCE = 250;
bool reiniciandoBalanza = false;
bool reiniciandoWifi = false;


// ------- BROKER -----
unsigned long ultimoIntentoMQTT = 0;
const unsigned long INTERVALO_MQTT = 2000; 
const char* MQTT_HOST = "broker.hivemq.com";
const int MQTT_PORT = 1883;
const char* MQTT_TOPIC_COMMAND = "iot-parcial-2/balanza-01/command";
const char* MQTT_TOPIC_STATUS = "iot-parcial-2/balanza-01/status";


PubSubClient mqtt(wifiClient);
// ─────────────────────────────────────────────────────────────



void setup() {
  Serial.begin(115200);
  
  pinMode(PIN_BTN_TARA, INPUT_PULLUP);
  pinMode(PIN_BTN_WIFI, INPUT_PULLUP);

  Wire.begin(LCD_SDA, LCD_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("Fallo OLED SSD1306");
    while (true) delay(100);
  }

  mostrarMensajeInicio();

  // Establecemos la balanza
  balanza.begin(HX711_DT, HX711_SCK);
  balanza.set_scale(FACTOR_CALIBRACION);
  delay(500);
  tararSeguro();


  
  conectarWifi();
  configurarMQTT();

}

int oldValue = LOW;

void loop() {
  
  float pesoKg = leerPeso();
  String estadoMsg = extrayendo ? "Extrayendo..." : "";
  mostrarPantalla(pesoKg, estadoMsg);
  

  // ---- Botón TARA ----
  if (digitalRead(PIN_BTN_TARA) == LOW && reiniciandoBalanza == false) {
    reiniciandoBalanza = true;
    ultimoTara = millis();
    balanza.tare();
    volverAModoReal();           // salir de la simulacion al re-tarar
    Serial.println("Tara reiniciada");
    reiniciandoBalanza = false;
  }

  // ---- Botón RESET WIFI ----
  if (digitalRead(PIN_BTN_WIFI) == LOW && reiniciandoWifi == false) {
    reiniciandoWifi = true;
    ultimoWifi = millis();
    mostrarPantalla(pesoKg, "Reiniciando WiFi...");
    Serial.println("Reiniciando WiFi");
    delay(600);
    reiniciandoWifi = false;
  }

  if (mqtt.connected()) 
  {
    mqtt.loop();   // procesa mensajes entrantes (callback)
    informarPeso(pesoKg);
  } else {
    unsigned long ahora = millis();
    if (ahora - ultimoIntentoMQTT >= INTERVALO_MQTT) {
      ultimoIntentoMQTT = ahora;
      conectarMQTT();
    }
  }


  
 // if (!mqtt.connected()) conectarMQTT();
  //mqtt.loop();
}

// ---------- Lectura de peso ----------

// Lectura REAL del HX711 (en kg)
float leerPesoReal() {
  if (balanza.wait_ready_timeout(1000)) {
    float kg = balanza.get_units(10) / 1000.0;   // promedio de 10 lecturas
    return kg;                                    // se permiten valores negativos
  }
  Serial.println("HX711 no responde");
  return 10;
}

// Devuelve el peso a mostrar: simulado (con extraccion) o real
float leerPeso() {
  // Hasta que no se configure la descarga (o fuera de simulacion) usamos
  // siempre la lectura del HX711.
  if (!MODO_SIMULACION || !descargaConfigurada) {
    return leerPesoReal();
  }

  if (extrayendo) {
    unsigned long ahora = millis();
    float dt = (ahora - ultimoMs) / 1000.0;
    ultimoMs = ahora;

    // Bajamos a la tasa fija, pero sin pasarnos de los gramos pedidos.
    float kgPaso = TASA_KG_S * dt;
    float kgPorExtraer = gramosPorExtraer / 1000.0;
    if (kgPaso > kgPorExtraer) kgPaso = kgPorExtraer;

    pesoSimuladoKg   -= kgPaso;
    gramosPorExtraer -= kgPaso * 1000.0;
    if (pesoSimuladoKg < 0) pesoSimuladoKg = 0;

    if (gramosPorExtraer <= 0.001 || pesoSimuladoKg <= 0) {
      gramosPorExtraer = 0;
      extrayendo = false;
      Serial.println("Extraccion completa");
    }
  }

  return pesoSimuladoKg;
}
// Inicia una extraccion de una cantidad FIJA de gramos desde el peso actual.
void iniciarExtraccion(float gramos) {
  if (gramos <= 0) {
    Serial.println("Nada que extraer");
    return;
  }

  // Partimos del peso simulado ACTUAL (sembrado al configurar la descarga),
  // para no perder las extracciones previas.
  gramosPorExtraer = gramos;           // cantidad fija a remover
  extrayendo       = true;
  ultimoMs         = millis();

  Serial.printf("Extraccion de %.2f g iniciada (desde %.3f kg)\n", gramos, pesoSimuladoKg);
}

void tararSeguro() {
  if (balanza.wait_ready_timeout(1000)) {
    balanza.tare(20);
    Serial.println("Tara OK");
  } else {
    Serial.println("HX711 no responde - tara omitida");
  }
}

// ---------- Pantalla OLED ----------
void mostrarPantalla(float pesoKg, String msg) {
  display.clearDisplay();

  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print("WiFi: ");
  display.println(WiFi.status() == WL_CONNECTED ? "Conectado" : "Desconectado");

  display.setTextSize(2);
  display.setCursor(0, 22);
  display.print(pesoKg, 3);
  display.println(" kg");

  display.setTextSize(1);
  display.setCursor(0, 50);
  if (msg.length() > 0) {
    display.println(msg);
  } else {
    display.println("BTN: Tara / WiFi");
  }

  display.display();
}

void mostrarMensajeInicio() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("Balanza 50kg");
  display.println("Iniciando...");
  display.display();
}

void reiniciarBalanza() {
  if (balanza.wait_ready_timeout(1000)) {
    balanza.tare(20);
    mostrarMensajeInicio();
  } else {
    Serial.println("HX711 no responde");
  }
}

void conectarWifi() {
  prefs.begin("wifi", true);
  String ssid = prefs.getString("ssid", "Wokwi-GUEST");
  String pass = prefs.getString("pass", "");
  prefs.end();

  WiFi.begin(ssid.c_str(), pass.c_str());

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 10000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  Serial.println(WiFi.status() == WL_CONNECTED ? "WiFi OK" : "WiFi fallo");
}


/*
*  Configuramos el servidor y el callback para el MQTT
*/
void configurarMQTT(){
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(alRecibirMensaje);
}

bool conectarMQTT() {
  if (WiFi.status() != WL_CONNECTED)
  {
     return false;
  }
  Serial.print("Conectando al broker...");
  String clientId = "balanzita-" + String(random(0xffff), HEX);
  if (mqtt.connect(clientId.c_str())) {
    mqtt.subscribe(MQTT_TOPIC_COMMAND);
    Serial.print("Suscripto a: ");
    Serial.println(MQTT_TOPIC_COMMAND);
    return true;
  } else {
    Serial.print(" fallo (");
    Serial.print(mqtt.state());
    Serial.println(")");
    return false;
  }
}


// Descarta la simulacion y vuelve a usar la lectura real del HX711.
void volverAModoReal() {
  descargaConfigurada = false;
  extrayendo = false;
  gramosPorExtraer = 0;
  Serial.println("Simulacion reiniciada: usando peso real");
}


void alRecibirMensaje(char* topic, byte* payload, unsigned int length) {


  if (strcmp(topic, MQTT_TOPIC_COMMAND) != 0) { // Si el topic no es el de comando lo ignoramos. Para no tener que escuchar los de estatus enviados por el mismo ESP32.
    return;
  }

  String message;
  message.reserve(length);
  
  for (unsigned int i = 0; i < length; i++)
  {
    message += (char)payload[i];
  } 


  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, message);

  Serial.print(message);
  if ( error ) {
    Serial.print("Error al parsear JSON: ");
    Serial.println(error.c_str());

    mqtt.publish( MQTT_TOPIC_STATUS, "{\"type\":\"status\",\"message\":\"JSON invalido\"}" );
    return;
  }

  const char* action = doc["action"] | "";

  if (strcmp(action, "config") == 0) {
    float capacity = doc["capacity"] | 0.0f;
    float discharge = doc["discharge"] | 0.0f;

    Serial.println("Accion: configurar descarga");
    Serial.printf("Capacidad: %.2f g\n", capacity);
    Serial.printf("Descarga: %.2f g\n", discharge);

    pesoSimuladoKg = leerPesoReal();
    descargaConfigurada = true;

    mqtt.publish( MQTT_TOPIC_STATUS, "{\"type\":\"operation_started\",\"action\":\"config\"}" );
  }

  if (strcmp(action, "unload") == 0) {
    float weight = doc["weight"] | 0.0f; 

    Serial.println("Accion: descargar");
    Serial.printf("Peso a extraer: %.2f g\n", weight);

    mqtt.publish( MQTT_TOPIC_STATUS, "{\"type\":\"operation_started\",\"action\":\"unload\"}" );

    iniciarExtraccion(weight);
  }

  if (strcmp(action, "reset") == 0) {
    mqtt.publish( MQTT_TOPIC_STATUS, "{\"type\":\"operation_started\",\"action\":\"reset\"}" );
    Serial.println("Accion: reset");
    volverAModoReal();
    reiniciarBalanza();
    mqtt.publish( MQTT_TOPIC_STATUS, "{\"type\":\"operation_completed\",\"action\":\"reset\"}" );
  }
}


void informarPeso( float pesoActualKg ) 
{
  JsonDocument doc;
  doc["type"] = "weight";
  doc["weight"] = pesoActualKg * 1000;
  char output[128];
  serializeJson(doc, output);
  mqtt.publish(MQTT_TOPIC_STATUS, output);
}