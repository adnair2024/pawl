from django.contrib.auth.decorators import login_required
from django.contrib.auth.mixins import LoginRequiredMixin
from django.http import HttpResponse
from django.views import View
from rest_framework.views import APIView


@login_required
def profile(request):
    return HttpResponse("me")


class Dash(LoginRequiredMixin, View):
    def get(self, request):
        return HttpResponse("dash")


class Defaulted(APIView):
    pass
