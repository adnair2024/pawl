from django.http import HttpResponse
from django.views import View
from rest_framework.views import APIView


def profile(request):
    return HttpResponse("me")


class Dash(View):
    def get(self, request):
        return HttpResponse("dash")


class Defaulted(APIView):
    pass
