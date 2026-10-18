from django.contrib.auth.decorators import login_required, permission_required
from django.contrib.auth.mixins import LoginRequiredMixin
from django.http import HttpResponse, HttpResponseForbidden
from django.views import View
from django.views.generic import ListView
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.views import APIView

from .mixins import StaffRequiredMixin
from .permissions import AlwaysYes, IsOwner


def home(request):
    return HttpResponse("hi")


@login_required
def profile(request):
    return HttpResponse("me")


@permission_required("shop.change_item")
def edit(request):
    return HttpResponse("edit")


def secret(request):
    if not request.user.is_authenticated:
        return HttpResponseForbidden()
    return HttpResponse("s")


class Dash(LoginRequiredMixin, View):
    def get(self, request):
        return HttpResponse("dash")


class Wrong(View, LoginRequiredMixin):
    # the mixin comes after View, so View.dispatch runs first and the mixin never checks anyone
    def get(self, request):
        return HttpResponse("wrong")


class Reports(StaffRequiredMixin, ListView):
    template_name = "reports.html"


@api_view(["GET"])
def api_default(request):
    return HttpResponse("d")


@api_view(["GET"])
@permission_classes([AllowAny])
def api_open(request):
    return HttpResponse("o")


@api_view(["POST"])
@permission_classes([IsAuthenticated, IsOwner])
def api_owned(request):
    return HttpResponse("w")


class Orders(APIView):
    permission_classes = [IsAuthenticated]


class OpenThing(APIView):
    permission_classes = [AlwaysYes]


class Defaulted(APIView):
    pass
