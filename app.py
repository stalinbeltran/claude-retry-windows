# Servidor web minimo usando solo la libreria estandar de Python
import http.server   # Modulo con el servidor HTTP basico
import socketserver  # Manejador de conexiones TCP

PUERTO = 8000  # Puerto donde escuchara el servidor


# Handler que sirve archivos estaticos; index.html se entrega en la raiz "/"
# porque SimpleHTTPRequestHandler ya usa index.html como pagina por defecto.
class Handler(http.server.SimpleHTTPRequestHandler):
    pass


# Crea el servidor enlazado al puerto y lo mantiene en ejecucion
with socketserver.TCPServer(("", PUERTO), Handler) as httpd:
    print(f"Servidor activo en http://localhost:{PUERTO}")
    httpd.serve_forever()  # Atiende peticiones hasta detener el proceso
