from django.http import JsonResponse


def api(request):
    resp = JsonResponse({})
    resp["Access-Control-Allow-Origin"] = request.headers.get("Origin")
    return resp
